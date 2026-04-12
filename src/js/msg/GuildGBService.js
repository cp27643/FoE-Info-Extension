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
 * Guild Great Building Scanner — 1.9 Thread Calculator
 *
 * Scans all guild members for GB contribution opportunities using the
 * standard "1.9 thread" model: for each rank, the break-even contribution
 * is floor(baseReward × 1.9). Shows how much FP remains to fill each
 * spot and your actual profit based on your real Arc bonus.
 *
 * Reuses the shared transport, parsing, and batch infrastructure from
 * NeighborGBService.js.
 */

import {
  guildScanDiv,
  gameJsonUrl,
  gameRequestId,
  PlayerID,
  availablePacksFP,
} from '../index.js';
import { guildMembers } from './OtherPlayerService.js';
import { City } from './StartupService.js';
import * as element from '../fn/AddElement';
import * as collapse from '../fn/collapse.js';
import {
  isSecretDiscovered,
  tryDiscoverSecret,
} from '../fn/requestIdTracker.js';
import { availableFP } from './ResourceService.js';
import { makeSortable } from '../fn/sortableTable.js';
import {
  postChunkedBatchRequest,
  extractGBRows,
  progressPct,
  exportSpotsToExcel,
} from './NeighborGBService.js';

// ---------------------------------------------------------------------------
// 1.9 Break-Even Calculation
// ---------------------------------------------------------------------------

// For each rank (1–5), calculates the "1.9 price" — the maximum FP a
// contributor can invest and break even assuming a 1.9× multiplier (90% Arc).
// Also returns the user's actual profit based on their real Arc bonus.
function calculate19Spots(rankings, remaining, arcBonus) {
  const Top = [0, 0, 0, 0, 0, 0];
  const rewards = [0, 0, 0, 0, 0];
  const medals = [0, 0, 0, 0, 0];
  const blueprints = [0, 0, 0, 0, 0];

  let myRank = 0;
  let myFP = 0;
  for (const place of rankings ?? []) {
    const rank = place.rank;
    if (!rank) continue;
    if (rank >= 1 && rank <= 5) {
      Top[rank - 1] = place.forge_points ?? 0;
      rewards[rank - 1] = place.reward?.strategy_point_amount ?? 0;
      medals[rank - 1] = place.reward?.resources?.medals ?? 0;
      blueprints[rank - 1] = place.reward?.blueprints ?? 0;
      if (place.player?.is_self || place.player?.player_id == PlayerID) {
        myRank = rank;
        myFP = place.forge_points ?? 0;
      }
    } else if (rank === 6) {
      Top[5] = place.forge_points ?? 0;
      if (place.player?.is_self || place.player?.player_id == PlayerID) {
        myFP = place.forge_points ?? 0;
      }
    }
  }

  const remainingFP = remaining ?? 0;
  const userArcMultiplier = 1 + (arcBonus ?? 90) / 100;
  const THREAD_MULTIPLIER = 1.9;
  const spots = [];

  for (let index = 0; index < 5; index++) {
    if (!rewards[index]) continue;

    const rank = index + 1;
    const baseReward = rewards[index];

    // Check who holds this position — in a 1.9 thread, only vacant
    // positions or positions the user already partially holds are relevant.
    const holderEntry = (rankings ?? []).find((p) => p.rank === rank);
    const isVacant =
      !holderEntry?.player?.name ||
      holderEntry.player.name === 'No contributor yet';
    const isSelf =
      holderEntry?.player?.is_self ||
      holderEntry?.player?.player_id == PlayerID;

    // Skip positions already claimed by another player
    if (!isVacant && !isSelf) continue;

    // 1.9 price: the break-even contribution at 1.9× multiplier
    // Game rounds rewards, so use Math.round to match
    const threadPrice = Math.round(baseReward * THREAD_MULTIPLIER);

    // What's currently in this rank
    const currentFP = Top[index];

    // How much FP is still needed to fill this spot to the 1.9 price
    // For vacant positions: full thread price
    // For self-held positions: remaining to reach 1.9
    const fpNeeded = Math.max(0, threadPrice - currentFP);

    // If already filled or overfilled, skip
    if (fpNeeded <= 0) continue;

    // Safety check: calculate the lock cost to verify the position is secure.
    // Use the same lock formula as the snipe scanner.
    let maxBelowFP = 0;
    for (let k = index; k < 6; k++) {
      if (myRank > 0 && k === myRank - 1) continue;
      if ((Top[k] || 0) > maxBelowFP) maxBelowFP = Top[k] || 0;
    }
    const lockFromThreat = Math.ceil((maxBelowFP + remainingFP + myFP) / 2);
    const lockToBeat = myRank === rank ? 0 : currentFP + 1;
    const lockCost = Math.max(lockFromThreat, lockToBeat);

    // Determine the effective cost and whether the position is viable:
    // Normal case: building has enough FP left to fill to the 1.9 price
    // Near-completion: building is almost done — contribute all remaining FP
    //   to level the building for the guild member (not a snipe)
    let effectiveCost;
    let isNearCompletion = false;

    if (remainingFP > 0 && fpNeeded > remainingFP) {
      // Building will complete before we can fill to the 1.9 price.
      // Contribute ALL remaining FP to level it for our guild member.
      isNearCompletion = true;
      effectiveCost = remainingFP;

      // Must still be able to secure the rank
      if (lockCost > remainingFP) continue;
    } else {
      // Normal 1.9 thread fill
      effectiveCost = threadPrice;

      // The 1.9 price must actually lock the position
      if (threadPrice < lockCost) continue;
    }

    // User's actual reward with their real Arc bonus
    const userReward = Math.round(baseReward * userArcMultiplier);
    // Profit based on effective cost (thread price or remaining FP)
    const userProfit = userReward - effectiveCost;

    spots.push({
      rank,
      currentHolder: isVacant ? '(open)' : (holderEntry?.player?.name ?? '?'),
      currentFP,
      threadPrice: isNearCompletion ? effectiveCost : threadPrice,
      fpNeeded: isNearCompletion ? effectiveCost : fpNeeded,
      isNearCompletion,
      myFP,
      baseRewardFP: baseReward,
      rewardFP: userReward,
      userProfit,
      profitPct:
        effectiveCost > 0 ?
          Math.round((userProfit / effectiveCost) * 100)
        : 0,
      rewardMedals: medals[index],
      rewardBlueprints: blueprints[index],
    });
  }

  return spots;
}

// ---------------------------------------------------------------------------
// Results renderer
// ---------------------------------------------------------------------------

function showGuildScanResults(profitable, scanned, total, statusMsg) {
  const arcBonus = City.ArcBonus ?? 90;
  const status =
    statusMsg ? statusMsg
    : total > 0 ?
      `Scanned ${scanned}/${total} guild members — ${profitable.length} building(s) with 1.9 opportunities (Arc ${arcBonus}%)`
    : 'Scanning…';

  let html = `<div class="alert alert-success alert-dismissible show collapsed" role="alert">
    <p id="guildScanLabel" href="#guildScanText" data-bs-toggle="collapse">
      ${element.icon('guildScanicon', 'guildScanText', collapse.collapseGuildScan)}
      <strong>Guild GB 1.9 Scanner</strong> — <small>${status}</small></p>
    ${element.close()}
    <div id="guildScanText" class="resize collapse ${collapse.collapseGuildScan == false ? 'show' : ''}">`;

  // Flatten all spots with parent info for sorting
  const allSpots = [];
  for (const item of profitable) {
    for (const spot of item.spots) {
      allSpots.push({ ...item, spot });
    }
  }

  // Sort by most FP needed first (biggest opportunities)
  allSpots.sort((a, b) => b.spot.fpNeeded - a.spot.fpNeeded);

  // Keep only the best spot per player+building
  const seen = new Set();
  const dedupedSpots = allSpots.filter((entry) => {
    const key = `${entry.playerName}|${entry.name}|${entry.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (dedupedSpots.length) {
    const totalFP = (availablePacksFP || 0) + (availableFP || 0);
    const fpLabel =
      totalFP > 0 ? `Available FP: ${totalFP.toLocaleString()}` : '';
    html += `<p class="mb-1 small text-muted">${fpLabel}
      <button id="guildCsvBtn" class="btn btn-sm btn-outline-secondary ms-2">📊 Export Excel</button></p>`;
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>#</th><th>Player</th><th>Building</th><th>Progress</th><th>Rank</th>
        <th>1.9 Price</th><th>Current</th><th>FP Needed</th><th>Reward</th><th>Profit</th><th>Medals</th><th>BPs</th>
      </tr></thead><tbody>`;

    for (const entry of dedupedSpots) {
      const { spot } = entry;
      const pct =
        entry.maxProgress > 0 ?
          Math.round((entry.currentProgress / entry.maxProgress) * 100)
        : '?';
      const totalFPAvail = (availablePacksFP || 0) + (availableFP || 0);
      const canAfford = totalFPAvail > 0 && spot.fpNeeded <= totalFPAvail;
      const rowClass =
        totalFPAvail > 0 ?
          canAfford ? ''
          : 'table-secondary'
        : '';
      const costClass =
        totalFPAvail > 0 ?
          canAfford ? 'text-success fw-bold'
          : 'text-danger'
        : '';
      const profitClass = spot.userProfit > 0 ? 'text-success' : 'text-danger';
      html += `<tr class="${rowClass}">
        <td>${entry.guildIndex ?? ''}</td>
        <td>${entry.playerName}</td>
        <td>${entry.name} Lv${entry.level}</td>
        <td>${pct}%</td>
        <td>#${spot.rank} ${spot.currentHolder}</td>
        <td>${spot.threadPrice}</td>
        <td>${spot.currentFP}</td>
        <td class="${costClass}">${spot.fpNeeded}</td>
        <td>${spot.rewardFP}</td>
        <td class="${profitClass}">${spot.userProfit}</td>
        <td>${spot.rewardMedals || 0}</td>
        <td>${spot.rewardBlueprints || 0}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  } else if (scanned === total && total > 0) {
    html += `<p class="mb-0">No open 1.9 spots found among guild members.</p>`;
  }

  html += `</div></div>`;

  // Preserve the scan button
  const btn = guildScanDiv.querySelector('#guildScanBtn');
  guildScanDiv.innerHTML = html;
  if (btn) guildScanDiv.prepend(btn);
  const tbl = guildScanDiv.querySelector('table');
  if (tbl) makeSortable(tbl);

  const csvBtn = guildScanDiv.querySelector('#guildCsvBtn');
  if (csvBtn) {
    csvBtn.addEventListener('click', () =>
      exportGuild19ToExcel(dedupedSpots, 'guild_19_scan'),
    );
  }

  document
    .getElementById('guildScanLabel')
    .addEventListener('click', collapse.fCollapseGuildScan);
}

// ---------------------------------------------------------------------------
// Excel export (adapted for 1.9 columns)
// ---------------------------------------------------------------------------

async function exportGuild19ToExcel(dedupedSpots, filename) {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Guild 1.9 Scan');

  const headers = [
    '#',
    'Player',
    'Building',
    'Progress',
    'Rank',
    '1.9 Price',
    'Current',
    'FP Needed',
    'Reward',
    'Profit',
    'Medals',
    'BPs',
  ];
  const headerRow = ws.addRow(headers);

  // Header styling
  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF198754' },
  };
  const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { horizontal: 'center' };
  });

  const totalFP = (availablePacksFP || 0) + (availableFP || 0);

  for (const entry of dedupedSpots) {
    const { spot } = entry;
    const pct =
      entry.maxProgress > 0 ? entry.currentProgress / entry.maxProgress : 0;

    const row = ws.addRow([
      entry.guildIndex ?? '',
      entry.playerName,
      `${entry.name} Lv${entry.level}`,
      pct,
      `#${spot.rank} ${spot.currentHolder}`,
      spot.threadPrice,
      spot.currentFP,
      spot.fpNeeded,
      spot.rewardFP,
      spot.userProfit,
      spot.rewardMedals || 0,
      spot.rewardBlueprints || 0,
    ]);

    // Progress column as percentage
    row.getCell(4).numFmt = '0%';

    // FP Needed coloring
    const canAfford = totalFP > 0 && spot.fpNeeded <= totalFP;
    if (totalFP > 0) {
      row.getCell(8).font = {
        bold: canAfford,
        color: { argb: canAfford ? 'FF198754' : 'FFDC3545' },
      };
    }

    // Profit coloring
    row.getCell(10).font = {
      bold: true,
      color: { argb: spot.userProfit > 0 ? 'FF198754' : 'FFDC3545' },
    };

    // Gray out unaffordable rows
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

  // Column widths
  ws.columns = [
    { width: 5 },
    { width: 18 },
    { width: 22 },
    { width: 10 },
    { width: 18 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
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
// Core scan
// ---------------------------------------------------------------------------

// Core scan data function — returns { profitable, total } without rendering.
export async function scanGuildData(onProgress) {
  const memberList = guildMembers.filter(
    (e) => e.is_guild_member || e.hasOwnProperty('is_guild_member'),
  );
  const total = memberList.length;
  console.log('[GuildGB] Scanning', total, 'guild members (batched)');

  const overviewPayloads = memberList.map((m) => ({
    __class__: 'ServerRequest',
    requestData: [m.player_id],
    requestClass: 'GreatBuildingsService',
    requestMethod: 'getOtherPlayerOverview',
  }));

  if (onProgress) onProgress('Fetching guild member overviews…');
  const overviewResponse = await postChunkedBatchRequest(overviewPayloads);

  const overviewResults = [];
  if (Array.isArray(overviewResponse)) {
    const gbResponses = overviewResponse.filter(
      (m) =>
        m?.requestClass === 'GreatBuildingsService' &&
        m?.requestMethod === 'getOtherPlayerOverview',
    );
    console.log(
      '[GuildGB] Got',
      gbResponses.length,
      'overview responses from batch',
    );

    for (let i = 0; i < gbResponses.length; i++) {
      const resp = gbResponses[i];
      const member = memberList[i];
      if (!member) continue;
      const rows =
        Array.isArray(resp?.responseData) ?
          resp.responseData.filter(
            (r) => r?.__class__ === 'GreatBuildingContributionRow',
          )
        : [];
      overviewResults.push({ member, memberIndex: i, rows });
    }
  }

  const arcBonus = City.ArcBonus ?? 90;
  const constructionMeta = [];
  const constructionPayloads = [];

  for (const { member, memberIndex, rows } of overviewResults) {
    for (const row of rows) {
      if (
        row?.entity_id &&
        row?.player?.player_id &&
        typeof row.current_progress === 'number' &&
        row.current_progress > 0
      ) {
        constructionMeta.push({
          memberIndex,
          playerName: member.name ?? String(member.player_id),
          playerId: Number(row.player.player_id),
          entityId: Number(row.entity_id),
          name: String(row.name ?? ''),
          level: Number(row.level ?? 0),
          currentProgress: Number(row.current_progress),
          maxProgress:
            row.max_progress != null ? Number(row.max_progress) : null,
        });
        constructionPayloads.push({
          __class__: 'ServerRequest',
          requestData: [row.entity_id, row.player.player_id],
          requestClass: 'GreatBuildingsService',
          requestMethod: 'getConstruction',
        });
      }
    }
  }

  console.log(
    '[GuildGB] Phase 2:',
    constructionPayloads.length,
    'construction requests',
  );

  const profitable = [];

  if (constructionPayloads.length > 0) {
    if (onProgress)
      onProgress(`Fetching ${constructionPayloads.length} building details…`);
    const constructionResponse =
      await postChunkedBatchRequest(constructionPayloads);

    const constructionResults =
      Array.isArray(constructionResponse) ?
        constructionResponse.filter(
          (m) =>
            m?.requestClass === 'GreatBuildingsService' &&
            m?.requestMethod === 'getConstruction',
        )
      : [];

    for (let i = 0; i < constructionMeta.length; i++) {
      const meta = constructionMeta[i];
      const resp = constructionResults[i];
      const construction = resp?.responseData;

      if (!construction || construction.__class__ === 'Error') continue;

      const cp =
        construction.state?.current_progress ??
        construction.current_progress ??
        meta.currentProgress;
      const mp =
        construction.state?.max_progress ??
        construction.max_progress ??
        meta.maxProgress;
      const remaining = mp != null && cp != null ? mp - cp : null;

      const rankings = construction.rankings ?? [];
      if (!rankings.length) continue;

      const spots = calculate19Spots(rankings, remaining, arcBonus);
      if (spots.length) {
        profitable.push({
          playerName: meta.playerName,
          guildIndex: meta.memberIndex + 1,
          name: meta.name,
          level: meta.level,
          currentProgress: cp,
          maxProgress: mp,
          remaining,
          spots,
        });
      }
    }
  }

  console.log(
    '[GuildGB] Scan complete —',
    profitable.length,
    'buildings with 1.9 opportunities found',
  );
  return { profitable, total };
}

async function scanAllGuildGBs() {
  console.log('[GuildGB] === SCAN BUTTON CLICKED ===');

  if (!guildMembers.length) {
    guildScanDiv.innerHTML = `<div class="alert alert-warning">Guild member list not loaded — open the game's social bar first.</div>`;
    return;
  }

  const btn = guildScanDiv.querySelector('#guildScanBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';
  }

  try {
    const { profitable, total } = await scanGuildData((msg) =>
      showGuildScanResults([], 0, 0, msg),
    );
    showGuildScanResults(profitable, total, total);
    console.log(
      '[GuildGB] Scan complete —',
      profitable.length,
      'buildings with 1.9 opportunities found',
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Scan Guild GBs (1.9)';
    }
  }
}

// ---------------------------------------------------------------------------
// Init — button + readiness dashboard
// ---------------------------------------------------------------------------

export function initGuildScanUI() {
  const btn = document.createElement('button');
  btn.id = 'guildScanBtn';
  btn.className = 'btn btn-sm btn-outline-success mt-1 mb-1';
  btn.textContent = 'Scan Guild GBs (1.9)';
  btn.disabled = true;
  btn.addEventListener('click', scanAllGuildGBs);

  const statusDiv = document.createElement('div');
  statusDiv.id = 'guildScanStatus';
  statusDiv.className = 'small text-muted mb-1';
  statusDiv.style.lineHeight = '1.4';

  guildScanDiv.appendChild(btn);
  guildScanDiv.appendChild(statusDiv);

  tryDiscoverSecret().catch(() => {});

  const checkInterval = setInterval(() => {
    const ready = updateGuildScanReadiness(btn, statusDiv);
    if (ready) clearInterval(checkInterval);
  }, 2000);
  updateGuildScanReadiness(btn, statusDiv);
}

function updateGuildScanReadiness(btn, statusDiv) {
  const checks = [
    {
      label: 'Guild list',
      ok: guildMembers.length > 0,
      detail:
        guildMembers.length > 0 ?
          `${guildMembers.length} members`
        : 'open social bar',
    },
    {
      label: 'Game URL',
      ok: !!gameJsonUrl,
      detail: gameJsonUrl ? 'captured' : 'waiting for game traffic',
    },
    {
      label: 'Request ID',
      ok: gameRequestId > 0,
      detail:
        gameRequestId > 0 ? `#${gameRequestId}` : 'waiting for game traffic',
    },
    {
      label: 'Player ID',
      ok: !!PlayerID,
      detail: PlayerID ? `${PlayerID}` : 'waiting for login data',
    },
    {
      label: 'Arc bonus',
      ok: City.ArcBonus != null,
      detail: City.ArcBonus != null ? `${City.ArcBonus}%` : 'defaults to 90%',
    },
    {
      label: 'Secret key',
      ok: isSecretDiscovered(),
      detail:
        isSecretDiscovered() ? 'discovered' : 'auto-discovers on first scan',
    },
  ];

  const coreReady = checks[0].ok && checks[1].ok && checks[2].ok;

  btn.disabled = !coreReady;
  btn.className =
    coreReady ?
      'btn btn-sm btn-success mt-1 mb-1'
    : 'btn btn-sm btn-outline-secondary mt-1 mb-1';

  const lines = checks.map((c) => {
    const icon =
      c.ok ? '✅'
      : c.label === 'Arc bonus' || c.label === 'Secret key' ? '⏳'
      : '❌';
    return `${icon} ${c.label}: ${c.detail}`;
  });
  statusDiv.innerHTML = lines.join('<br>');

  return checks.every((c) => c.ok);
}
