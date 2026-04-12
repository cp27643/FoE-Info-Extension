/*
 * ________________________________________________________________
 * Copyright (C) 2022 FoE-Info - All Rights Reserved
 * this source-code uses a copy-left license
 *
 * you are welcome to contribute changes here:
 * https://github.com/FoE-Info/FoE-Info-Extension
 *
 * AGPL license and info:
 * https://github.com/FoE-Info/FoE-Info-Extension/master/LICENSE.md
 * or else visit https://www.gnu.org/licenses/#AGPL
 * ________________________________________________________________
 */

/*
 * Scan All — Unified GB Scanner
 *
 * Runs hood, friends, and guild scans in parallel (sequentially to avoid
 * server overload), then merges all results into a single table with a
 * "Source" column identifying where each opportunity came from.
 */

import { scanAllDiv, availablePacksFP, url, MyInfo } from '../index.js';
import { hoodlist, friends, guildMembers } from './OtherPlayerService.js';
import { City } from './StartupService.js';
import * as element from '../fn/AddElement';
import * as collapse from '../fn/collapse.js';
import { availableFP } from './ResourceService.js';
import { makeSortable } from '../fn/sortableTable.js';
import { scanHoodData } from './NeighborGBService.js';
import { scanFriendsData } from './FriendsGBService.js';
import { scanGuildData } from './GuildGBService.js';
import browser from 'webextension-polyfill';

// ---------------------------------------------------------------------------
// Strategy Insights — optimal contribution recommendations
// ---------------------------------------------------------------------------

const STRATEGIES = [
  { id: 'max-profit', label: '💰 Max FP Profit' },
  { id: 'max-medals', label: '🏅 Max Medals' },
  { id: 'high-roi', label: '📈 High ROI First' },
  { id: 'balanced', label: '⚖️ Balanced' },
];

let currentStrategy = 'max-profit';
let lastAllRows = [];

function getValueFn(rows, strategyId) {
  switch (strategyId) {
    case 'max-profit':
      return (r) => r.profit;
    case 'max-medals':
      return (r) => r.medals;
    case 'high-roi':
      return (r) => (r.profit > 0 ? r.roi : 0);
    case 'balanced': {
      const maxProfit = Math.max(...rows.map((r) => r.profit), 1);
      const maxMedals = Math.max(...rows.map((r) => r.medals), 1);
      const maxBps = Math.max(...rows.map((r) => r.bps), 1);
      return (r) =>
        (Math.max(0, r.profit) / maxProfit) * 0.5 +
        (r.medals / maxMedals) * 0.35 +
        (r.bps / maxBps) * 0.15;
    }
    default:
      return (r) => r.profit;
  }
}

function solveStrategy(rows, budget, strategyId) {
  if (budget <= 0 || rows.length === 0) return new Set();

  const valueFn = getValueFn(rows, strategyId);

  // Build candidates with row indices
  const candidates = rows
    .map((r, i) => ({
      ...r,
      rowIndex: i,
      value: valueFn(r),
    }))
    .filter((c) => c.value > 0 && c.cost > 0 && c.cost <= budget);

  if (candidates.length === 0) return new Set();

  // Sort by value/cost ratio descending (greedy knapsack)
  candidates.sort(
    (a, b) => b.value / Math.max(b.cost, 1) - a.value / Math.max(a.cost, 1),
  );

  // Greedy pick with conflict tracking (max one rank per building)
  const picks = new Set();
  const pickedBuildings = new Set();
  let remaining = budget;

  for (const c of candidates) {
    const key = `${c.playerName}|${c.building}`;
    if (pickedBuildings.has(key)) continue;
    if (c.cost > remaining) continue;

    picks.add(c.rowIndex);
    pickedBuildings.add(key);
    remaining -= c.cost;
  }

  // Enhancement: check if a single high-value item beats the greedy set
  const greedyTotal = [...picks].reduce((sum, i) => sum + valueFn(rows[i]), 0);
  const singleBest = candidates.reduce(
    (best, c) => (!best || c.value > best.value ? c : best),
    null,
  );
  if (singleBest && singleBest.value > greedyTotal) {
    return new Set([singleBest.rowIndex]);
  }

  return picks;
}

function computeTotals(rows, picks) {
  let cost = 0,
    profit = 0,
    medals = 0,
    bps = 0;
  for (const i of picks) {
    const r = rows[i];
    cost += r.cost;
    profit += r.profit;
    medals += r.medals;
    bps += r.bps;
  }
  return { cost, profit, medals, bps, count: picks.size };
}

// ---------------------------------------------------------------------------
// Results renderer
// ---------------------------------------------------------------------------

function showScanAllResults(allRows) {
  lastAllRows = allRows;
  const arcBonus = City.ArcBonus ?? 90;
  const totalFP = (availablePacksFP || 0) + (availableFP || 0);

  // Compute strategy picks
  const picks = solveStrategy(allRows, totalFP, currentStrategy);
  const totals = computeTotals(allRows, picks);

  const status = `${allRows.length} opportunities across all sources (Arc ${arcBonus}%)`;

  // Final results always render expanded so the table is visible
  let html = `<div class="alert alert-dark alert-dismissible show" role="alert">
    <p id="scanAllLabel" href="#scanAllText" data-bs-toggle="collapse">
      ${element.icon('scanAllicon', 'scanAllText', false)}
      <strong>Scan All — Combined Results</strong> — <small>${status}</small></p>
    ${element.close()}
    <div id="scanAllText" class="resize collapse show">`;

  if (allRows.length) {
    // Strategy dropdown + summary banner
    const fpLabel =
      totalFP > 0 ? `Available FP: ${totalFP.toLocaleString()}` : '';
    const strategyOptions = STRATEGIES.map(
      (s) =>
        `<option value="${s.id}" ${s.id === currentStrategy ? 'selected' : ''}>${s.label}</option>`,
    ).join('');

    html += `<div class="d-flex align-items-center gap-2 flex-wrap mb-2">
      <span class="small text-muted">${fpLabel}</span>
      <button id="scanAllCsvBtn" class="btn btn-sm btn-outline-secondary">📊 Export Excel</button>
    </div>`;

    if (totalFP > 0) {
      html += `<div class="card mb-2" style="background: #2b2b2b; border: 1px solid #444;">
        <div class="card-body p-2">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <strong class="text-light">📊 Strategy:</strong>
            <select id="strategyDropdown" class="form-select form-select-sm"
                    style="width: auto; background: #333; color: #eee; border-color: #555;">
              ${strategyOptions}
            </select>
            <span class="ms-auto small text-light">`;

      if (picks.size > 0) {
        html += `<span class="badge bg-warning text-dark">${totals.count} pick${totals.count > 1 ? 's' : ''}</span>
              Cost: ${totals.cost.toLocaleString()} / ${totalFP.toLocaleString()} FP
              | <span class="text-success fw-bold">Profit: +${totals.profit.toLocaleString()}</span>
              | Medals: ${totals.medals.toLocaleString()}
              | BPs: ${totals.bps.toLocaleString()}`;
      } else {
        html += `<span class="text-muted">No profitable picks within budget</span>`;
      }

      html += `</span></div></div></div>`;
    }

    // Table with pick column
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>Pick</th><th>Source</th><th>#</th><th>Player</th><th>Building</th><th>Progress</th><th>Rank</th>
        <th>Cost</th><th>Reward</th><th>Profit</th><th>ROI</th><th>Medals</th><th>BPs</th>
      </tr></thead><tbody>`;

    // Sort: picks first, then by profit descending within each group
    const sorted = allRows
      .map((r, i) => ({ ...r, _i: i }))
      .sort((a, b) => {
        const aPick = picks.has(a._i) ? 0 : 1;
        const bPick = picks.has(b._i) ? 0 : 1;
        if (aPick !== bPick) return aPick - bPick;
        return b.profit - a.profit;
      });

    for (const row of sorted) {
      const isPick = picks.has(row._i);
      const canAfford = totalFP > 0 && row.cost <= totalFP;
      const rowClass =
        isPick ? 'table-warning'
        : totalFP > 0 && !canAfford ? 'table-secondary'
        : '';
      const costClass =
        totalFP > 0 ?
          canAfford ? 'text-success fw-bold'
          : 'text-danger'
        : '';
      const profitClass = row.profit > 0 ? 'text-success' : 'text-danger';
      const sourceBadge =
        row.source === 'Hood' ? 'bg-warning text-dark'
        : row.source === 'Friends' ? 'bg-info text-dark'
        : 'bg-success';

      html += `<tr class="${rowClass}">
        <td>${isPick ? '✅' : ''}</td>
        <td><span class="badge ${sourceBadge}">${row.source}</span></td>
        <td>${row.number}</td>
        <td>${row.playerName}</td>
        <td>${row.building}</td>
        <td>${row.progress}%</td>
        <td>#${row.rank} ${row.holder}</td>
        <td class="${costClass}">${row.cost}</td>
        <td>${row.reward}</td>
        <td class="${profitClass}">${row.profit}</td>
        <td>${row.roi}%</td>
        <td>${row.medals}</td>
        <td>${row.bps}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<p class="mb-0">No opportunities found across hood, friends, or guild.</p>`;
  }

  html += `</div></div>`;

  // Remove any old results panel but keep the button
  const oldPanel = scanAllDiv.querySelector('.alert');
  if (oldPanel) oldPanel.remove();

  // Insert results panel after button
  const resultsDiv = document.createElement('div');
  resultsDiv.innerHTML = html;
  scanAllDiv.appendChild(resultsDiv);

  const tbl = scanAllDiv.querySelector('table');
  if (tbl) makeSortable(tbl);

  const csvBtn = scanAllDiv.querySelector('#scanAllCsvBtn');
  if (csvBtn) {
    csvBtn.addEventListener('click', () =>
      exportScanAllToExcel(allRows, 'scan_all_gb'),
    );
  }

  const dropdown = scanAllDiv.querySelector('#strategyDropdown');
  if (dropdown) {
    dropdown.addEventListener('change', (e) => {
      currentStrategy = e.target.value;
      showScanAllResults(lastAllRows);
    });
  }

  document
    .getElementById('scanAllLabel')
    .addEventListener('click', collapse.fCollapseScanAll);
}

// ---------------------------------------------------------------------------
// Normalize spots from different scanner types into unified rows
// ---------------------------------------------------------------------------

function normalizeSnipeSpots(profitable, source) {
  const rows = [];
  for (const item of profitable) {
    for (const spot of item.spots) {
      const pct =
        item.maxProgress > 0 ?
          Math.round((item.currentProgress / item.maxProgress) * 100)
        : 0;
      rows.push({
        source,
        number: item.hoodIndex ?? item.friendIndex ?? '',
        playerName: item.playerName,
        building: `${item.name} Lv${item.level}`,
        progress: pct,
        rank: spot.rank,
        holder: spot.currentHolder,
        cost: spot.lockCost,
        reward: spot.rewardFP,
        profit: spot.lockProfit,
        roi: spot.profitPct,
        medals: spot.rewardMedals || 0,
        bps: spot.rewardBlueprints || 0,
      });
    }
  }
  return rows;
}

function normalize19Spots(profitable, source) {
  const rows = [];
  for (const item of profitable) {
    for (const spot of item.spots) {
      const pct =
        item.maxProgress > 0 ?
          Math.round((item.currentProgress / item.maxProgress) * 100)
        : 0;
      rows.push({
        source,
        number: item.guildIndex ?? '',
        playerName: item.playerName,
        building: `${item.name} Lv${item.level}`,
        progress: pct,
        rank: spot.rank,
        holder: spot.currentHolder,
        cost: spot.threadPrice,
        reward: spot.rewardFP,
        profit: spot.userProfit,
        roi: spot.profitPct,
        medals: spot.rewardMedals || 0,
        bps: spot.rewardBlueprints || 0,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Excel export
// ---------------------------------------------------------------------------

async function exportScanAllToExcel(allRows, filename) {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Scan All');

  const headers = [
    'Source',
    '#',
    'Player',
    'Building',
    'Progress',
    'Rank',
    'Cost',
    'Reward',
    'Profit',
    'ROI',
    'Medals',
    'BPs',
  ];
  const headerRow = ws.addRow(headers);

  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF343A40' },
  };
  const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { horizontal: 'center' };
  });

  const totalFP = (availablePacksFP || 0) + (availableFP || 0);

  for (const r of allRows) {
    const row = ws.addRow([
      r.source,
      r.number,
      r.playerName,
      r.building,
      r.progress / 100,
      `#${r.rank} ${r.holder}`,
      r.cost,
      r.reward,
      r.profit,
      r.roi / 100,
      r.medals,
      r.bps,
    ]);

    row.getCell(5).numFmt = '0%';
    row.getCell(10).numFmt = '0%';

    const canAfford = totalFP > 0 && r.cost <= totalFP;
    if (totalFP > 0) {
      row.getCell(7).font = {
        bold: canAfford,
        color: { argb: canAfford ? 'FF198754' : 'FFDC3545' },
      };
    }

    row.getCell(9).font = {
      bold: true,
      color: { argb: r.profit > 0 ? 'FF198754' : 'FFDC3545' },
    };

    if (totalFP > 0 && !canAfford) {
      const grayFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F0F0' },
      };
      row.eachCell((cell) => {
        cell.fill = grayFill;
      });
    }
  }

  ws.columns = [
    { width: 10 },
    { width: 6 },
    { width: 18 },
    { width: 22 },
    { width: 10 },
    { width: 18 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 8 },
    { width: 10 },
    { width: 8 },
  ];

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: ws.rowCount, column: headers.length },
  };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Progress rendering — lightweight updates without rebuilding the DOM
// ---------------------------------------------------------------------------

function showProgress(pct, label) {
  let container = scanAllDiv.querySelector('#scanAllProgress');
  if (!container) {
    container = document.createElement('div');
    container.id = 'scanAllProgress';
    container.className = 'mb-2';
    // Insert after the button row
    const btnRow = scanAllDiv.querySelector('#scanAllBtnRow');
    if (btnRow) btnRow.after(container);
    else scanAllDiv.appendChild(container);
  }
  container.innerHTML = `
    <div class="small text-muted mb-1">${label}</div>
    <div class="progress" style="height: 18px;">
      <div class="progress-bar progress-bar-striped progress-bar-animated bg-dark"
           role="progressbar" style="width: ${pct}%"
           aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        ${Math.round(pct)}%
      </div>
    </div>`;
}

function clearProgress() {
  const el = scanAllDiv.querySelector('#scanAllProgress');
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// Shared scan logic — collects rows without touching the UI
// ---------------------------------------------------------------------------

let scanInProgress = false;

async function collectAllRows(onProgress) {
  const allRows = [];
  const sources = [];

  const scans = [];
  if (hoodlist.length > 0) scans.push('hood');
  if (friends.length > 0) scans.push('friends');
  if (guildMembers.length > 0) scans.push('guild');

  if (scans.length === 0) return { allRows, sources, empty: true };

  const stepWeight = 100 / scans.length;
  let baseProgress = 0;

  if (hoodlist.length > 0) {
    try {
      const { profitable } = await scanHoodData((msg) =>
        onProgress?.(baseProgress + stepWeight * 0.3, `Hood: ${msg}`),
      );
      const rows = normalizeSnipeSpots(profitable, 'Hood');
      allRows.push(...rows);
      sources.push(`Hood: ${rows.length}`);
    } catch (e) {
      console.warn('[ScanAll] Hood scan failed:', e);
      sources.push('Hood: failed');
    }
    baseProgress += stepWeight;
    onProgress?.(baseProgress, 'Hood complete');
  }

  if (friends.length > 0) {
    try {
      const { profitable } = await scanFriendsData((msg) =>
        onProgress?.(baseProgress + stepWeight * 0.3, `Friends: ${msg}`),
      );
      const rows = normalizeSnipeSpots(profitable, 'Friends');
      allRows.push(...rows);
      sources.push(`Friends: ${rows.length}`);
    } catch (e) {
      console.warn('[ScanAll] Friends scan failed:', e);
      sources.push('Friends: failed');
    }
    baseProgress += stepWeight;
    onProgress?.(baseProgress, 'Friends complete');
  }

  if (guildMembers.length > 0) {
    try {
      const { profitable } = await scanGuildData((msg) =>
        onProgress?.(baseProgress + stepWeight * 0.3, `Guild: ${msg}`),
      );
      const rows = normalize19Spots(profitable, 'Guild');
      allRows.push(...rows);
      sources.push(`Guild: ${rows.length}`);
    } catch (e) {
      console.warn('[ScanAll] Guild scan failed:', e);
      sources.push('Guild: failed');
    }
    baseProgress += stepWeight;
  }

  allRows.sort((a, b) => b.profit - a.profit);
  return { allRows, sources, empty: false };
}

// ---------------------------------------------------------------------------
// Manual scan — runs all scans with UI feedback
// ---------------------------------------------------------------------------

async function runScanAll() {
  if (scanInProgress) return;
  scanInProgress = true;
  console.log('[ScanAll] === SCAN ALL CLICKED ===');

  const btn = scanAllDiv.querySelector('#scanAllBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Scanning all…';
  }

  const oldPanel = scanAllDiv.querySelector('.alert');
  if (oldPanel) oldPanel.remove();

  try {
    const { allRows, sources, empty } = await collectAllRows((pct, label) =>
      showProgress(pct, label),
    );

    if (empty) {
      showProgress(100, 'No player lists loaded — open the social bar first.');
      return;
    }

    showProgress(100, 'Building results table…');
    clearProgress();
    showScanAllResults(allRows);
    console.log('[ScanAll] Complete —', sources.join(', '));
  } finally {
    scanInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 Scan All';
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-scan state
// ---------------------------------------------------------------------------

let autoScanRunning = false;
let autoScanTimeoutId = null;
let countdownIntervalId = null;
let nextScanTime = 0;
let lastScanStats = { time: null, alerts: 0 };
let lastSeenKeys = new Set(); // keys from previous scan cycle

function getAutoScanSettings() {
  const webhookURL = (url && url.discordScanAlertURL) || '';
  let roi = 500;
  // scanAlertROI is stored at top-level in storage, read from the url obj
  // We'll read it fresh each cycle from storage for reliability
  return { webhookURL, roi };
}

async function loadROIThreshold() {
  try {
    const result = await browser.storage.local.get('scanAlertROI');
    const val = parseInt(result.scanAlertROI, 10);
    return isNaN(val) || val < 0 ? 500 : val;
  } catch (e) {
    return 500;
  }
}

// ---------------------------------------------------------------------------
// Discord webhook — send formatted alert
// ---------------------------------------------------------------------------

const DISCORD_MAX_CHARS = 1900;

function sendDiscordWebhook(webhookURL, messages) {
  if (!webhookURL || messages.length === 0) return;

  // Chunk messages to stay under Discord's 2000 char limit
  const chunks = [];
  let current = '';

  for (const msg of messages) {
    if (current.length + msg.length + 1 > DISCORD_MAX_CHARS) {
      if (current) chunks.push(current);
      current = msg;
    } else {
      current += (current ? '\n' : '') + msg;
    }
  }
  if (current) chunks.push(current);

  const playerName = (MyInfo && MyInfo.name) || 'FoE-Info';

  for (let i = 0; i < chunks.length; i++) {
    const header =
      chunks.length > 1 ?
        `🔔 **FoE Snipe Alert** (${i + 1}/${chunks.length})\n\n`
      : '🔔 **FoE Snipe Alert**\n\n';

    const oReq = new XMLHttpRequest();
    oReq.open('POST', webhookURL, true);
    oReq.setRequestHeader('Content-type', 'application/json');
    oReq.onreadystatechange = function () {
      if (oReq.readyState === XMLHttpRequest.DONE && oReq.status >= 400) {
        console.warn(
          '[AutoScan] Discord webhook error:',
          oReq.status,
          oReq.responseText,
        );
      }
    };
    oReq.send(
      JSON.stringify({
        username: playerName,
        avatar_url: '',
        content: header + chunks[i],
      }),
    );
  }
}

function formatAlertLine(row, idx) {
  const num = idx + 1;
  const circle = String.fromCodePoint(0x245f + num); // ①②③…
  const tag =
    row.source === 'Hood' ? '🏘️ Neighbor'
    : row.source === 'Friends' ? '🤝 Friend'
    : '⚔️ Guild';
  const playerNum = row.number ? ` #${row.number}` : '';
  return (
    `${num <= 20 ? circle : `(${num})`} **${row.playerName}** [${tag}${playerNum}] — ${row.building} | #${row.rank}\n` +
    `   Cost: ${row.cost} FP | Reward: ${row.reward} FP | Profit: +${row.profit} | ROI: ${row.roi}%`
  );
}

// ---------------------------------------------------------------------------
// Auto-scan cycle
// ---------------------------------------------------------------------------

async function runAutoScanCycle() {
  if (scanInProgress) {
    console.log('[AutoScan] Skipping — scan already in progress');
    scheduleNextAutoScan();
    return;
  }

  scanInProgress = true;
  console.log('[AutoScan] === AUTO SCAN CYCLE ===');
  updateAutoScanStatus('Scanning…');

  try {
    const { allRows, sources, empty } = await collectAllRows(null);
    if (empty) {
      console.log('[AutoScan] No player lists loaded, skipping');
      lastScanStats = { time: new Date(), alerts: 0 };
      updateAutoScanStatus('No players loaded');
      return;
    }

    // Filter by ROI threshold
    const roiThreshold = await loadROIThreshold();
    const webhookURL = (url && url.discordScanAlertURL) || '';
    const qualifying = allRows.filter((r) => r.roi >= roiThreshold);

    // Build keys for this cycle
    const currentKeys = new Set();
    for (const row of qualifying) {
      currentKeys.add(`${row.playerName}|${row.building}|${row.rank}`);
    }

    // New = in this scan but not in the previous scan
    const newAlerts = qualifying.filter(
      (r) => !lastSeenKeys.has(`${r.playerName}|${r.building}|${r.rank}`),
    );

    // Update seen set for next cycle
    lastSeenKeys = currentKeys;

    console.log(
      `[AutoScan] ${qualifying.length} above ${roiThreshold}% ROI, ${newAlerts.length} new`,
    );

    // Send Discord alerts for new opportunities
    if (newAlerts.length > 0 && webhookURL) {
      const lines = newAlerts.map((r, i) => formatAlertLine(r, i));
      const header = `Found **${newAlerts.length}** new opportunit${newAlerts.length === 1 ? 'y' : 'ies'} (ROI ≥ ${roiThreshold}%):\n`;
      sendDiscordWebhook(webhookURL, [header, ...lines]);
    }

    lastScanStats = { time: new Date(), alerts: newAlerts.length };
    console.log('[AutoScan] Complete —', sources.join(', '));
  } catch (e) {
    console.warn('[AutoScan] Cycle failed:', e);
    lastScanStats = { time: new Date(), alerts: 0 };
  } finally {
    scanInProgress = false;
  }

  if (autoScanRunning) scheduleNextAutoScan();
}

function scheduleNextAutoScan() {
  const delayMs = 300000 + Math.random() * 60000; // 5–6 min
  nextScanTime = Date.now() + delayMs;
  autoScanTimeoutId = setTimeout(runAutoScanCycle, delayMs);
  startCountdown();
}

// ---------------------------------------------------------------------------
// Auto-scan UI controls
// ---------------------------------------------------------------------------

function startCountdown() {
  if (countdownIntervalId) clearInterval(countdownIntervalId);
  countdownIntervalId = setInterval(updateCountdownDisplay, 1000);
  updateCountdownDisplay();
}

function stopCountdown() {
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

function updateCountdownDisplay() {
  const el = scanAllDiv.querySelector('#autoScanCountdown');
  if (!el) return;

  const remaining = Math.max(0, nextScanTime - Date.now());
  const min = Math.floor(remaining / 60000);
  const sec = Math.floor((remaining % 60000) / 1000);
  const countdown = `${min}:${sec.toString().padStart(2, '0')}`;

  el.textContent = `Next scan in ${countdown}`;
}

function updateAutoScanStatus(msg) {
  const el = scanAllDiv.querySelector('#autoScanStatus');
  if (!el) return;

  if (msg) {
    el.textContent = msg;
    return;
  }

  if (!autoScanRunning) {
    el.textContent = '';
    return;
  }

  const parts = [];
  if (lastScanStats.time) {
    const t = lastScanStats.time;
    parts.push(
      `Last: ${t.getHours()}:${t.getMinutes().toString().padStart(2, '0')} (${lastScanStats.alerts} alert${lastScanStats.alerts !== 1 ? 's' : ''})`,
    );
  }
  el.textContent = parts.join(' | ');
}

function toggleAutoScan() {
  if (autoScanRunning) {
    stopAutoScan();
  } else {
    startAutoScan();
  }
}

function startAutoScan() {
  const webhookURL = (url && url.discordScanAlertURL) || '';
  if (!webhookURL) {
    const statusEl = scanAllDiv.querySelector('#autoScanStatus');
    if (statusEl)
      statusEl.textContent =
        '⚠️ Set a Discord webhook URL in Settings → Webhooks first';
    return;
  }

  autoScanRunning = true;
  lastSeenKeys = new Set();

  const btn = scanAllDiv.querySelector('#autoScanToggle');
  if (btn) {
    btn.textContent = '⏹ Stop Auto-Scan';
    btn.classList.remove('btn-outline-success');
    btn.classList.add('btn-outline-danger');
  }

  const countdownEl = scanAllDiv.querySelector('#autoScanCountdown');
  if (countdownEl) countdownEl.style.display = '';

  console.log('[AutoScan] Started');
  runAutoScanCycle();
}

function stopAutoScan() {
  autoScanRunning = false;

  if (autoScanTimeoutId) {
    clearTimeout(autoScanTimeoutId);
    autoScanTimeoutId = null;
  }
  stopCountdown();
  lastSeenKeys = new Set();

  const btn = scanAllDiv.querySelector('#autoScanToggle');
  if (btn) {
    btn.textContent = '▶️ Start Auto-Scan';
    btn.classList.remove('btn-outline-danger');
    btn.classList.add('btn-outline-success');
  }

  const countdownEl = scanAllDiv.querySelector('#autoScanCountdown');
  if (countdownEl) {
    countdownEl.style.display = 'none';
    countdownEl.textContent = '';
  }

  updateAutoScanStatus('Stopped');
  console.log('[AutoScan] Stopped');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initScanAllUI() {
  // Button row: Scan All + Auto-Scan toggle
  const btnRow = document.createElement('div');
  btnRow.id = 'scanAllBtnRow';
  btnRow.className = 'd-flex align-items-center gap-2 flex-wrap mt-1 mb-2';

  const btn = document.createElement('button');
  btn.id = 'scanAllBtn';
  btn.className = 'btn btn-sm btn-dark';
  btn.textContent = '🔍 Scan All';
  btn.addEventListener('click', runScanAll);
  btnRow.appendChild(btn);

  const autoBtn = document.createElement('button');
  autoBtn.id = 'autoScanToggle';
  autoBtn.className = 'btn btn-sm btn-outline-success';
  autoBtn.textContent = '▶️ Start Auto-Scan';
  autoBtn.addEventListener('click', toggleAutoScan);
  btnRow.appendChild(autoBtn);

  const countdown = document.createElement('span');
  countdown.id = 'autoScanCountdown';
  countdown.className = 'small text-muted';
  countdown.style.display = 'none';
  btnRow.appendChild(countdown);

  scanAllDiv.appendChild(btnRow);

  // Status line below buttons
  const statusLine = document.createElement('div');
  statusLine.id = 'autoScanStatus';
  statusLine.className = 'small text-muted mb-1';
  scanAllDiv.appendChild(statusLine);
}
