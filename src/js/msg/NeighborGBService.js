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
 * Neighbor Great Building Scanner
 *
 * Passive entry point: onNeighborOverviewReceived() fires whenever the game
 * sends a getOtherPlayerOverview response. Shows buildings with active FP progress
 * and calls getConstruction for profit analysis.
 *
 * Active entry point: scanAllNeighborGBs() iterates the full hoodlist, calls
 * getOtherPlayerOverview + getConstruction for every neighbor, and surfaces
 * profitable contributions (>20% profit margin based on your Arc bonus).
 *
 * Requests are sent via sendJsonRequestAtomic() from requestIdTracker.js, which
 * claims the next requestId and fires the XHR in a single inspectedWindow.eval()
 * call — eliminating the async gap that allowed the game's periodic timer to
 * steal the same requestId.
 */

import { overview, gbScanDiv, donationPercent } from '../index.js';
import { hoodlist } from './OtherPlayerService.js';
import * as element from '../fn/AddElement';
import { sendJsonRequestAtomic } from '../fn/requestIdTracker.js';

// ---------------------------------------------------------------------------
// Transport — atomic requestId claim + XHR via the page-level tracker
// ---------------------------------------------------------------------------

// Tracks requestIds we sent so index.js can skip double-processing our own
// responses through the normal game handler paths.
export const neighborGBRequestIds = new Set();

// POSTs a game API payload with automatic retry. sendJsonRequestAtomic handles
// requestId assignment and signature computation atomically inside the page
// context, so the game's periodic timer cannot steal the same ID.
async function postGameRequest(payloadTemplate) {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((res) => setTimeout(res, 300 * attempt));
    }

    try {
      const result = await sendJsonRequestAtomic(payloadTemplate);

      // Register the claimed requestId so index.js skips double-processing
      if (result.requestId != null) {
        neighborGBRequestIds.add(result.requestId);
        setTimeout(() => neighborGBRequestIds.delete(result.requestId), 500);
      }

      if (
        Array.isArray(result.response) &&
        result.response[0]?.__class__ === 'Error'
      ) {
        throw new Error(result.response[0].message ?? 'Game server error');
      }

      return result.response;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(
        `[NeighborGB] Request failed (attempt ${attempt + 1}), retrying:`,
        err.message,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Game API wrappers
// ---------------------------------------------------------------------------

async function getNeighborOverview(playerId) {
  return postGameRequest([
    {
      __class__: 'ServerRequest',
      requestData: [playerId],
      requestClass: 'GreatBuildingsService',
      requestMethod: 'getOtherPlayerOverview',
    },
  ]);
}

async function getNeighborConstruction(entityId, playerId) {
  return postGameRequest([
    {
      __class__: 'ServerRequest',
      requestData: [entityId, playerId],
      requestClass: 'GreatBuildingsService',
      requestMethod: 'getConstruction',
    },
  ]);
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

// Extracts GreatBuildingContributionRow objects from a getOtherPlayerOverview response.
function extractGBRows(response) {
  if (!Array.isArray(response)) return [];
  for (const item of response) {
    if (
      item?.requestClass === 'GreatBuildingsService' &&
      item?.requestMethod === 'getOtherPlayerOverview' &&
      Array.isArray(item?.responseData)
    ) {
      return item.responseData.filter(
        (r) => r?.__class__ === 'GreatBuildingContributionRow',
      );
    }
  }
  return [];
}

// Extracts the rankings array from a getConstruction response.
// Shape: responseData.rankings on the GreatBuildingsService ServerResponse entry.
function extractRankings(response) {
  if (!Array.isArray(response)) return null;
  for (const item of response) {
    if (
      item?.requestClass === 'GreatBuildingsService' &&
      item?.requestMethod === 'getConstruction' &&
      Array.isArray(item?.responseData?.rankings)
    ) {
      return item.responseData.rankings;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profit calculation
// ---------------------------------------------------------------------------

// For each reward rank (1–5), determines the minimum FP needed to secure it
// and whether that investment meets the 20% profit threshold given the player's
// Arc bonus (donationPercent / 100 = arcMultiplier).
function calculateProfitableSpots(rankings, remaining, arcMultiplier) {
  const spots = [];

  for (const place of rankings ?? []) {
    if (!place.rank || place.rank > 5) continue; // ranks 1–5 only
    if (!place.reward?.strategy_point_amount) continue; // must have a reward

    const isVacant =
      !place.player?.name || place.player.name === 'No contributor yet';
    const currentFP = place.forge_points ?? 0;

    // Minimum FP to secure the rank: take over from current holder or claim vacant spot
    const fpNeeded = isVacant ? 1 : currentFP + 1;
    if (remaining != null && fpNeeded > remaining) continue; // not enough room left

    const rewardFP = place.reward.strategy_point_amount;
    const actualReward = Math.round(rewardFP * arcMultiplier);
    const profitFP = actualReward - fpNeeded;
    const profitMargin = Math.round((profitFP / fpNeeded) * 100);

    if (profitMargin >= 20) {
      spots.push({
        rank: place.rank,
        currentHolder: isVacant ? '(open)' : place.player.name,
        fpNeeded,
        rewardFP,
        actualReward,
        profitFP,
        profitMargin,
      });
    }
  }

  return spots;
}

// ---------------------------------------------------------------------------
// Core processor
// ---------------------------------------------------------------------------

// Accepts an array of GreatBuildingContributionRow objects (from msg.responseData
// in the passive path, or from extractGBRows() in the active path).
// For buildings with current_progress > 0, calls getConstruction and scores profit.
async function processGBRows(rowsData) {
  const arcMultiplier = (donationPercent ?? 190) / 100;

  const activeRows = (rowsData ?? [])
    .filter(
      (row) =>
        row?.__class__ === 'GreatBuildingContributionRow' &&
        row?.entity_id &&
        row?.player?.player_id &&
        typeof row.current_progress === 'number' &&
        row.current_progress > 0,
    )
    .map((row) => ({
      playerId: Number(row.player.player_id),
      playerName: String(row.player.name ?? ''),
      entityId: Number(row.entity_id),
      name: String(row.name ?? ''),
      level: Number(row.level ?? 0),
      currentProgress: Number(row.current_progress),
      maxProgress: row.max_progress != null ? Number(row.max_progress) : null,
    }));

  if (!activeRows.length) return [];

  const results = [];

  for (const row of activeRows) {
    const remaining =
      row.maxProgress != null ? row.maxProgress - row.currentProgress : null;
    let profitableSpots = [];

    try {
      const constructionResponse = await getNeighborConstruction(
        row.entityId,
        row.playerId,
      );
      const rankings = extractRankings(constructionResponse);
      if (rankings) {
        profitableSpots = calculateProfitableSpots(
          rankings,
          remaining,
          arcMultiplier,
        );
      }
    } catch (err) {
      console.warn(
        '[NeighborGB] getConstruction failed for',
        row.name,
        ':',
        err.message,
      );
    }

    results.push({
      playerId: row.playerId,
      playerName: row.playerName,
      entityId: row.entityId,
      name: row.name,
      level: row.level,
      maxProgressFromOverview: row.maxProgress,
      currentProgress: row.currentProgress,
      profitableSpots,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function progressPct(current, max) {
  if (!max || max <= 0) return '?';
  const raw = (current / max) * 100;
  return raw > 0 && raw < 1 ? '<1' : Math.round(raw);
}

// Renders a single-player passive scan result into the overview div.
function showPassiveResults(results) {
  if (!results.length) {
    overview.innerHTML = '';
    return;
  }

  const playerName = results[0]?.playerName ?? 'Unknown';
  let html = `<div class="alert alert-info alert-dismissible show" role="alert">
    ${element.close()}
    <p><strong>GB Progress: ${playerName}</strong></p>`;

  for (const r of results) {
    const pct = progressPct(r.currentProgress, r.maxProgressFromOverview);
    html +=
      `<div><strong>${r.name}</strong> Lv${r.level}: ` +
      `${r.currentProgress}/${r.maxProgressFromOverview ?? '?'} FP (${pct}%)`;

    for (const spot of r.profitableSpots) {
      html +=
        `<div class="ms-2 text-success">Rank ${spot.rank} ${spot.currentHolder}: ` +
        `${spot.fpNeeded}FP → ${spot.actualReward}FP (+${spot.profitMargin}%)</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  overview.innerHTML = html;
}

// Renders full-scan results (all neighbors) into gbScanDiv.
function showScanResults(profitable, scanned, total) {
  const status =
    total > 0 ?
      `Scanned ${scanned}/${total} neighbors — ${profitable.length} profitable spot(s)`
    : 'Scanning…';

  let html = `<div class="alert alert-warning alert-dismissible show" role="alert">
    ${element.close()}
    <p><strong>Hood GB Profit Scan</strong> — <small>${status}</small></p>`;

  if (profitable.length) {
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>Player</th><th>Building</th><th>Rank</th>
        <th>FP needed</th><th>Reward</th><th>Margin</th>
      </tr></thead><tbody>`;

    for (const item of profitable) {
      for (const spot of item.spots) {
        html += `<tr>
          <td>${item.playerName}</td>
          <td>${item.name} Lv${item.level}</td>
          <td>#${spot.rank} ${spot.currentHolder}</td>
          <td>${spot.fpNeeded}</td>
          <td>${spot.actualReward}FP</td>
          <td class="text-success">+${spot.profitMargin}%</td>
        </tr>`;
      }
    }
    html += `</tbody></table>`;
  } else if (scanned === total && total > 0) {
    html += `<p class="mb-0">No profitable spots found at your current Arc bonus.</p>`;
  }

  html += `</div>`;

  // Preserve the scan button that sits before the results area
  const btn = gbScanDiv.querySelector('#gbScanBtn');
  gbScanDiv.innerHTML = html;
  if (btn) gbScanDiv.prepend(btn);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Called from index.js when the game sends a getOtherPlayerOverview response.
// responseData is msg.responseData — already the flat array of GreatBuildingContributionRow objects.
export async function onNeighborOverviewReceived(responseData) {
  const results = await processGBRows(responseData);
  showPassiveResults(results);
  return results;
}

// Scans every player in hoodlist: overview → construction → profit analysis.
// Renders progressive results into gbScanDiv as each player is processed.
export async function scanAllNeighborGBs() {
  if (!hoodlist.length) {
    gbScanDiv.innerHTML = `<div class="alert alert-warning">Hood list not loaded — open the game's hood/social list first.</div>`;
    return;
  }

  const neighbors = hoodlist.filter(
    (e) => e.is_neighbor || e.hasOwnProperty('is_neighbor'),
  );
  const total = neighbors.length;
  const profitable = [];

  console.log('[NeighborGB] Starting full hood scan —', total, 'neighbors');

  for (let i = 0; i < neighbors.length; i++) {
    const neighbor = neighbors[i];
    const playerId = neighbor.player_id;
    const playerName = neighbor.name ?? String(playerId);

    showScanResults(profitable, i, total);

    try {
      const overviewResponse = await getNeighborOverview(playerId);
      const rows = extractGBRows(overviewResponse);
      const results = await processGBRows(rows);

      for (const r of results) {
        if (r.profitableSpots.length) {
          profitable.push({
            playerName,
            name: r.name,
            level: r.level,
            spots: r.profitableSpots,
          });
        }
      }
    } catch (err) {
      console.warn(
        '[NeighborGB] Failed scanning',
        playerName,
        ':',
        err.message,
      );
    }

    // Yield to avoid blocking the UI on large hood lists
    await new Promise((res) => setTimeout(res, 50));
  }

  // Sort by highest profit margin first
  profitable.sort(
    (a, b) =>
      Math.max(...b.spots.map((s) => s.profitMargin)) -
      Math.max(...a.spots.map((s) => s.profitMargin)),
  );

  showScanResults(profitable, total, total);
  console.log(
    '[NeighborGB] Scan complete —',
    profitable.length,
    'profitable spots found',
  );
}

// Renders the "Scan Hood GBs" button into gbScanDiv.
// Called once from index.js after the div is in the DOM.
export function initGBScanUI() {
  const btn = document.createElement('button');
  btn.id = 'gbScanBtn';
  btn.className = 'btn btn-sm btn-outline-warning mt-1 mb-1';
  btn.textContent = 'Scan Hood GBs';
  btn.addEventListener('click', scanAllNeighborGBs);
  gbScanDiv.appendChild(btn);
}
