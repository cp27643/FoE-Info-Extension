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

import { scanAllDiv, availablePacksFP } from '../index.js';
import { hoodlist, friends, guildMembers } from './OtherPlayerService.js';
import { City } from './StartupService.js';
import * as element from '../fn/AddElement';
import * as collapse from '../fn/collapse.js';
import { availableFP } from './ResourceService.js';
import { makeSortable } from '../fn/sortableTable.js';
import { scanHoodData } from './NeighborGBService.js';
import { scanFriendsData } from './FriendsGBService.js';
import { scanGuildData } from './GuildGBService.js';

// ---------------------------------------------------------------------------
// Results renderer
// ---------------------------------------------------------------------------

function showScanAllResults(allRows, statusMsg) {
  const arcBonus = City.ArcBonus ?? 90;
  const status =
    statusMsg ??
    `${allRows.length} opportunities across all sources (Arc ${arcBonus}%)`;

  let html = `<div class="alert alert-dark alert-dismissible show collapsed" role="alert">
    <p id="scanAllLabel" href="#scanAllText" data-bs-toggle="collapse">
      ${element.icon('scanAllicon', 'scanAllText', collapse.collapseScanAll)}
      <strong>Scan All — Combined Results</strong> — <small>${status}</small></p>
    ${element.close()}
    <div id="scanAllText" class="resize collapse ${collapse.collapseScanAll == false ? 'show' : ''}">`;

  if (allRows.length) {
    const totalFP = (availablePacksFP || 0) + (availableFP || 0);
    const fpLabel =
      totalFP > 0 ? `Available FP: ${totalFP.toLocaleString()}` : '';
    html += `<p class="mb-1 small text-muted">${fpLabel}
      <button id="scanAllCsvBtn" class="btn btn-sm btn-outline-secondary ms-2">📊 Export Excel</button></p>`;
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>Source</th><th>Player</th><th>Building</th><th>Progress</th><th>Rank</th>
        <th>Cost</th><th>Reward</th><th>Profit</th><th>ROI</th><th>Medals</th><th>BPs</th>
      </tr></thead><tbody>`;

    for (const row of allRows) {
      const canAfford = totalFP > 0 && row.cost <= totalFP;
      const rowClass =
        totalFP > 0 ?
          canAfford ? ''
          : 'table-secondary'
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
        <td><span class="badge ${sourceBadge}">${row.source}</span></td>
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
  } else if (!statusMsg) {
    html += `<p class="mb-0">No opportunities found across hood, friends, or guild.</p>`;
  }

  html += `</div></div>`;

  const btn = scanAllDiv.querySelector('#scanAllBtn');
  scanAllDiv.innerHTML = html;
  if (btn) scanAllDiv.prepend(btn);
  const tbl = scanAllDiv.querySelector('table');
  if (tbl) makeSortable(tbl);

  const csvBtn = scanAllDiv.querySelector('#scanAllCsvBtn');
  if (csvBtn) {
    csvBtn.addEventListener('click', () =>
      exportScanAllToExcel(allRows, 'scan_all_gb'),
    );
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
        playerName: item.playerName,
        building: `${item.name} Lv${item.level}`,
        progress: pct,
        rank: spot.rank,
        holder: spot.currentHolder,
        cost: spot.fpNeeded,
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

    row.getCell(4).numFmt = '0%';
    row.getCell(9).numFmt = '0%';

    const canAfford = totalFP > 0 && r.cost <= totalFP;
    if (totalFP > 0) {
      row.getCell(6).font = {
        bold: canAfford,
        color: { argb: canAfford ? 'FF198754' : 'FFDC3545' },
      };
    }

    row.getCell(8).font = {
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
// Core scan — runs all available scans sequentially, merges results
// ---------------------------------------------------------------------------

async function runScanAll() {
  console.log('[ScanAll] === SCAN ALL CLICKED ===');

  const btn = scanAllDiv.querySelector('#scanAllBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Scanning all…';
  }

  try {
    const allRows = [];
    const sources = [];

    // Run scans sequentially to avoid overwhelming the server
    if (hoodlist.length > 0) {
      showScanAllResults([], 'Scanning hood…');
      try {
        const { profitable } = await scanHoodData();
        const rows = normalizeSnipeSpots(profitable, 'Hood');
        allRows.push(...rows);
        sources.push(`Hood: ${rows.length}`);
      } catch (e) {
        console.warn('[ScanAll] Hood scan failed:', e);
        sources.push('Hood: failed');
      }
    } else {
      sources.push('Hood: skipped (no list)');
    }

    if (friends.length > 0) {
      showScanAllResults(allRows, 'Scanning friends…');
      try {
        const { profitable } = await scanFriendsData();
        const rows = normalizeSnipeSpots(profitable, 'Friends');
        allRows.push(...rows);
        sources.push(`Friends: ${rows.length}`);
      } catch (e) {
        console.warn('[ScanAll] Friends scan failed:', e);
        sources.push('Friends: failed');
      }
    } else {
      sources.push('Friends: skipped (no list)');
    }

    if (guildMembers.length > 0) {
      showScanAllResults(allRows, 'Scanning guild…');
      try {
        const { profitable } = await scanGuildData();
        const rows = normalize19Spots(profitable, 'Guild');
        allRows.push(...rows);
        sources.push(`Guild: ${rows.length}`);
      } catch (e) {
        console.warn('[ScanAll] Guild scan failed:', e);
        sources.push('Guild: failed');
      }
    } else {
      sources.push('Guild: skipped (no list)');
    }

    // Dedupe: keep best profit per player+building per source
    const seen = new Set();
    const deduped = allRows.filter((row) => {
      const key = `${row.source}|${row.playerName}|${row.building}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by profit descending
    deduped.sort((a, b) => b.profit - a.profit);

    showScanAllResults(deduped);
    console.log('[ScanAll] Complete —', sources.join(', '));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 Scan All';
    }
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initScanAllUI() {
  const btn = document.createElement('button');
  btn.id = 'scanAllBtn';
  btn.className = 'btn btn-sm btn-dark mt-1 mb-2';
  btn.textContent = '🔍 Scan All';
  btn.addEventListener('click', runScanAll);

  scanAllDiv.appendChild(btn);
}
