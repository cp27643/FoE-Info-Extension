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
 * Friends Great Building Scanner
 *
 * Scans all friends for profitable GB contributions, similar to the hood
 * scanner in NeighborGBService.js. Includes medal and blueprint counts
 * in the results.
 *
 * Reuses the shared transport, parsing, and profit calculation from
 * NeighborGBService.js.
 */

import {
  friendsScanDiv,
  gameJsonUrl,
  gameRequestId,
  PlayerID,
  availablePacksFP,
} from '../index.js';
import { friends } from './OtherPlayerService.js';
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
  calculateProfitableSpots,
  progressPct,
  exportSpotsToExcel,
} from './NeighborGBService.js';

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showFriendsScanResults(profitable, scanned, total, statusMsg) {
  const arcBonus = City.ArcBonus ?? 90;
  const status =
    statusMsg ? statusMsg
    : total > 0 ?
      `Scanned ${scanned}/${total} friends — ${profitable.length} building(s) with opportunities (Arc ${arcBonus}%)`
    : 'Scanning…';

  let html = `<div class="alert alert-info alert-dismissible show collapsed" role="alert">
    <p id="friendsScanLabel" href="#friendsScanText" data-bs-toggle="collapse">
      ${element.icon('friendsScanicon', 'friendsScanText', collapse.collapseFriendsScan)}
      <strong>Friends GB Snipe Scanner</strong> — <small>${status}</small></p>
    ${element.close()}
    <div id="friendsScanText" class="resize collapse ${collapse.collapseFriendsScan == false ? 'show' : ''}">`;

  // Flatten all spots with parent info for sorting
  const allSpots = [];
  for (const item of profitable) {
    for (const spot of item.spots) {
      allSpots.push({ ...item, spot });
    }
  }

  // Sort by highest lock profit first
  allSpots.sort((a, b) => b.spot.lockProfit - a.spot.lockProfit);

  // Keep only the most profitable spot per player+building
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
      <button id="friendsCsvBtn" class="btn btn-sm btn-outline-secondary ms-2">📊 Export Excel</button></p>`;
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>#</th><th>Player</th><th>Building</th><th>Progress</th><th>Rank</th>
        <th>Lock Cost</th><th>Reward</th><th>Profit</th><th>ROI</th><th>Medals</th><th>BPs</th>
      </tr></thead><tbody>`;

    for (const entry of dedupedSpots) {
      const { spot } = entry;
      const pct =
        entry.maxProgress > 0 ?
          Math.round((entry.currentProgress / entry.maxProgress) * 100)
        : '?';
      const canAfford = totalFP > 0 && spot.lockCost <= totalFP;
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
      html += `<tr class="${rowClass}">
        <td>${entry.friendIndex ?? ''}</td>
        <td>${entry.playerName}</td>
        <td>${entry.name} Lv${entry.level}</td>
        <td>${pct}%</td>
        <td>#${spot.rank} ${spot.currentHolder}</td>
        <td class="${costClass}">${spot.lockCost}</td>
        <td>${spot.rewardFP}</td>
        <td class="text-success">${spot.lockProfit}</td>
        <td>${spot.profitPct}%</td>
        <td>${spot.rewardMedals || 0}</td>
        <td>${spot.rewardBlueprints || 0}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  } else if (scanned === total && total > 0) {
    html += `<p class="mb-0">No profitable spots found at your current Arc bonus (${arcBonus}%).</p>`;
  }

  html += `</div></div>`;

  // Preserve the scan button that sits before the results area
  const btn = friendsScanDiv.querySelector('#friendsScanBtn');
  friendsScanDiv.innerHTML = html;
  if (btn) friendsScanDiv.prepend(btn);
  const tbl = friendsScanDiv.querySelector('table');
  if (tbl) makeSortable(tbl);

  const csvBtn = friendsScanDiv.querySelector('#friendsCsvBtn');
  if (csvBtn) {
    csvBtn.addEventListener('click', () =>
      exportSpotsToExcel(dedupedSpots, 'friends_gb_scan'),
    );
  }

  document
    .getElementById('friendsScanLabel')
    .addEventListener('click', collapse.fCollapseFriendsScan);
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

// Core scan data function — returns { profitable, total } without rendering.
export async function scanFriendsData(onProgress) {
  const friendList = friends.filter(
    (e) => e.is_friend || e.hasOwnProperty('is_friend'),
  );
  const total = friendList.length;
  console.log('[FriendsGB] Scanning', total, 'friends (batched)');

  const overviewPayloads = friendList.map((f) => ({
    __class__: 'ServerRequest',
    requestData: [f.player_id],
    requestClass: 'GreatBuildingsService',
    requestMethod: 'getOtherPlayerOverview',
  }));

  if (onProgress) onProgress('Fetching friend overviews…');
  const overviewResponse = await postChunkedBatchRequest(overviewPayloads);

  const overviewResults = [];
  if (Array.isArray(overviewResponse)) {
    const gbResponses = overviewResponse.filter(
      (m) =>
        m?.requestClass === 'GreatBuildingsService' &&
        m?.requestMethod === 'getOtherPlayerOverview',
    );
    console.log(
      '[FriendsGB] Got',
      gbResponses.length,
      'overview responses from batch',
    );

    for (let i = 0; i < gbResponses.length; i++) {
      const resp = gbResponses[i];
      const friend = friendList[i];
      if (!friend) continue;
      const rows =
        Array.isArray(resp?.responseData) ?
          resp.responseData.filter(
            (r) => r?.__class__ === 'GreatBuildingContributionRow',
          )
        : [];
      overviewResults.push({ friend, friendIndex: i, rows });
    }
  }

  const arcBonus = City.ArcBonus ?? 90;
  const constructionMeta = [];
  const constructionPayloads = [];

  for (const { friend, friendIndex, rows } of overviewResults) {
    for (const row of rows) {
      if (
        row?.entity_id &&
        row?.player?.player_id &&
        typeof row.current_progress === 'number' &&
        row.current_progress > 0
      ) {
        constructionMeta.push({
          friendIndex,
          playerName: friend.name ?? String(friend.player_id),
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
    '[FriendsGB] Phase 2:',
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

      const profitableSpots = calculateProfitableSpots(
        rankings,
        remaining,
        arcBonus,
      );
      if (profitableSpots.length) {
        profitable.push({
          playerName: meta.playerName,
          friendIndex: meta.friendIndex + 1,
          name: meta.name,
          level: meta.level,
          currentProgress: cp,
          maxProgress: mp,
          remaining,
          spots: profitableSpots,
        });
      }
    }
  }

  console.log(
    '[FriendsGB] Scan complete —',
    profitable.length,
    'profitable spots found',
  );
  return { profitable, total };
}

async function scanAllFriendGBs() {
  console.log('[FriendsGB] === SCAN BUTTON CLICKED ===');

  if (!friends.length) {
    friendsScanDiv.innerHTML = `<div class="alert alert-warning">Friends list not loaded — open the game's social bar first.</div>`;
    return;
  }

  const btn = friendsScanDiv.querySelector('#friendsScanBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';
  }

  try {
    const { profitable, total } = await scanFriendsData((msg) =>
      showFriendsScanResults([], 0, 0, msg),
    );
    showFriendsScanResults(profitable, total, total);
    console.log(
      '[FriendsGB] Scan complete —',
      profitable.length,
      'profitable spots found (2 XHR calls)',
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Scan Friends GBs';
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Renders the "Scan Friends GBs" button and readiness dashboard into friendsScanDiv.
// Called once from index.js after the div is in the DOM.
export function initFriendsScanUI() {
  const btn = document.createElement('button');
  btn.id = 'friendsScanBtn';
  btn.className = 'btn btn-sm btn-outline-info mt-1 mb-1';
  btn.textContent = 'Scan Friends GBs';
  btn.disabled = true;
  btn.addEventListener('click', scanAllFriendGBs);

  const statusDiv = document.createElement('div');
  statusDiv.id = 'friendsScanStatus';
  statusDiv.className = 'small text-muted mb-1';
  statusDiv.style.lineHeight = '1.4';

  friendsScanDiv.appendChild(btn);
  friendsScanDiv.appendChild(statusDiv);

  // Kick off secret discovery in the background so it's ready when needed
  tryDiscoverSecret().catch(() => {});

  // Periodic readiness check — updates every 2 s until all prerequisites are met
  const checkInterval = setInterval(() => {
    const ready = updateFriendsScanReadiness(btn, statusDiv);
    if (ready) clearInterval(checkInterval);
  }, 2000);
  // Run once immediately
  updateFriendsScanReadiness(btn, statusDiv);
}

function updateFriendsScanReadiness(btn, statusDiv) {
  const checks = [
    {
      label: 'Friends list',
      ok: friends.length > 0,
      detail:
        friends.length > 0 ? `${friends.length} friends` : 'open social bar',
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

  // Core prerequisites that must be met to enable the button
  const coreReady = checks[0].ok && checks[1].ok && checks[2].ok;

  btn.disabled = !coreReady;
  btn.className =
    coreReady ?
      'btn btn-sm btn-info mt-1 mb-1'
    : 'btn btn-sm btn-outline-secondary mt-1 mb-1';

  const lines = checks.map((c) => {
    const icon =
      c.ok ? '✅'
      : c.label === 'Arc bonus' || c.label === 'Secret key' ? '⏳'
      : '❌';
    return `${icon} ${c.label}: ${c.detail}`;
  });
  statusDiv.innerHTML = lines.join('<br>');

  const allReady = checks.every((c) => c.ok);
  return allReady;
}
