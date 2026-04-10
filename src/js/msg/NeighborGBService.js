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

import { overview, gbScanDiv, donationPercent, gameJsonUrl, gameRequestHeaders, gameRequestId, PlayerID } from '../index.js';
import { hoodlist } from './OtherPlayerService.js';
import { City } from './StartupService.js';
import * as element from '../fn/AddElement';
import { sendJsonRequestAtomic, isSecretDiscovered, tryDiscoverSecret } from '../fn/requestIdTracker.js';

// ---------------------------------------------------------------------------
// Transport — atomic requestId claim + XHR via the page-level tracker
// ---------------------------------------------------------------------------

// Tracks requestIds we sent so index.js can skip double-processing our own
// responses through the normal game handler paths.
export const neighborGBRequestIds = new Set();

// Scanner requestIds live in a separate range (1,000,000+) so they never
// collide with the game client's own counter (which increments from ~30-500).
// The server accepts non-sequential IDs; it only rejects duplicates.
const SCANNER_ID_BASE = 1_000_000;
let lastUsedRequestId = SCANNER_ID_BASE;

function getNextRequestId() {
  lastUsedRequestId += 1;
  return lastUsedRequestId;
}

// POSTs a game API payload with automatic retry.
async function postGameRequest(payloadTemplate) {
  const MAX_RETRIES = 3;
  console.log('[NeighborGB] postGameRequest called, method:', payloadTemplate[0]?.requestMethod);
  console.log('[NeighborGB] gameJsonUrl available:', !!gameJsonUrl, 'gameRequestId:', gameRequestId);

  if (!gameJsonUrl) {
    throw new Error('Game URL not captured yet — play the game for a moment so network traffic is intercepted.');
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log('[NeighborGB] Retry attempt', attempt + 1);
      await new Promise((res) => setTimeout(res, 300 * attempt));
    }

    const nextId = getNextRequestId();
    // Register BEFORE sending so the network listener in index.js always
    // sees the ID and skips double-processing the scanner's responses.
    neighborGBRequestIds.add(nextId);
    try {
      const result = await sendJsonRequestAtomic(payloadTemplate, {
        gameUrl: gameJsonUrl,
        clientId: gameRequestHeaders['client-identification'] || '',
        requestId: nextId,
      });
      console.log('[NeighborGB] sendJsonRequestAtomic returned, requestId:', result?.requestId, 'response type:', typeof result?.response, 'is array:', Array.isArray(result?.response));

      // Clean up after a generous delay so the network listener has time
      // to process the response through request.getContent().then(…).
      setTimeout(() => neighborGBRequestIds.delete(nextId), 30000);

      if (
        Array.isArray(result.response) &&
        result.response[0]?.__class__ === 'Error'
      ) {
        console.error('[NeighborGB] Game server error:', result.response[0].message);
        throw new Error(result.response[0].message ?? 'Game server error');
      }

      return result.response;
    } catch (err) {
      // Clean up the registered ID on failure so it doesn't linger
      setTimeout(() => neighborGBRequestIds.delete(nextId), 30000);
      console.warn('[NeighborGB] Request failed (attempt', attempt + 1, '):', err.message);
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Game API wrappers
// ---------------------------------------------------------------------------

async function getNeighborOverview(playerId) {
  console.log('[NeighborGB] getNeighborOverview for playerId:', playerId);
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
  console.log('[NeighborGB] getNeighborConstruction entityId:', entityId, 'playerId:', playerId);
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
  console.log('[NeighborGB] extractGBRows — response is array:', Array.isArray(response), 'length:', Array.isArray(response) ? response.length : 'N/A');
  if (!Array.isArray(response)) return [];
  for (const item of response) {
    console.log('[NeighborGB] extractGBRows item — requestClass:', item?.requestClass, 'requestMethod:', item?.requestMethod, 'responseData is array:', Array.isArray(item?.responseData));
    if (
      item?.requestClass === 'GreatBuildingsService' &&
      item?.requestMethod === 'getOtherPlayerOverview' &&
      Array.isArray(item?.responseData)
    ) {
      const rows = item.responseData.filter(
        (r) => r?.__class__ === 'GreatBuildingContributionRow',
      );
      console.log('[NeighborGB] extractGBRows found', rows.length, 'GreatBuildingContributionRow(s)');
      return rows;
    }
  }
  console.log('[NeighborGB] extractGBRows — no matching GreatBuildingsService/getOtherPlayerOverview item found');
  return [];
}

// Extracts the full construction data from a getConstruction response.
// Returns responseData which contains rankings, state, current_progress, etc.
function extractConstruction(response) {
  if (!Array.isArray(response)) return null;
  for (const item of response) {
    if (
      item?.requestClass === 'GreatBuildingsService' &&
      item?.requestMethod === 'getConstruction' &&
      item?.responseData
    ) {
      return item.responseData;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profit calculation
// ---------------------------------------------------------------------------

// For each reward rank (1–5), calculates the true cost to secure a position
// using the same formula as getPlaceValues() in GreatBuildingsService.js:
//
//   maxBelowFP  = max FP among contributors at or below the target rank
//                 (including rank 6 — the first unranked contributor)
//   lockCost    = max(ceil((maxBelowFP + remaining) / 2), currentRankFP + 1)
//   reward      = baseReward × (1 + ArcBonus / 100)
//   profit      = reward − lockCost
//
// A "snipeCost" (just beat current holder) is also returned for reference.
function calculateProfitableSpots(rankings, remaining, arcBonus) {
  // Build Top[0..5] array exactly like GreatBuildingsService does.
  // Top[0] through Top[4] = FP at ranks 1-5, Top[5] = rank 6 (first unranked).
  const Top = [0, 0, 0, 0, 0, 0];
  const rewards = [0, 0, 0, 0, 0];

  // Find the user's current rank and FP on this building
  let myRank = 0;
  let myFP = 0;
  for (const place of rankings ?? []) {
    const rank = place.rank;
    if (!rank) continue;
    if (rank >= 1 && rank <= 5) {
      Top[rank - 1] = place.forge_points ?? 0;
      rewards[rank - 1] = place.reward?.strategy_point_amount ?? 0;
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
  const arcMultiplier = 1 + (arcBonus ?? 90) / 100;
  const spots = [];

  for (let index = 0; index < 5; index++) {
    if (!rewards[index]) continue;

    const rank = index + 1;

    // Skip ranks worse than our current rank (higher number = worse)
    if (myRank > 0 && rank > myRank) continue;

    const isVacant =
      !rankings?.find(
        (p) =>
          p.rank === rank &&
          p.player?.name &&
          p.player.name !== 'No contributor yet',
      );
    const currentFP = Top[index];

    // Lock cost: same formula as getPlaceValues() in GreatBuildingsService.
    // Exclude our own position from the threat calculation — we can't outbid ourselves.
    let maxBelowFP = 0;
    for (let k = index; k < 6; k++) {
      if (myRank > 0 && k === myRank - 1) continue; // skip our own rank
      if ((Top[k] || 0) > maxBelowFP) maxBelowFP = Top[k] || 0;
    }
    // When user already has myFP on the building, contributing D total only
    // removes (D - myFP) from remaining, leaving more FP for the threat.
    const lockFromThreat = Math.ceil((maxBelowFP + remainingFP + myFP) / 2);
    // If we already hold this rank, we don't need to beat ourselves
    const lockToBeat = (myRank === rank) ? 0 : currentFP + 1;
    const totalLockCost = Math.max(lockFromThreat, lockToBeat);

    // Marginal cost: subtract FP we've already contributed
    const marginalCost = Math.max(0, totalLockCost - myFP);

    // If marginal cost is 0, we already lock this position — skip
    if (marginalCost <= 0) continue;

    if (remainingFP > 0 && marginalCost > remainingFP) continue;

    const rewardFP = Math.round(rewards[index] * arcMultiplier);
    const lockProfit = rewardFP - marginalCost;

    // Only include positions where the safe lock is profitable
    if (lockProfit <= 0) continue;

    const holder = rankings?.find((p) => p.rank === rank);
    const totalInvestment = myFP + marginalCost;
    const profitPct = totalInvestment > 0
      ? Math.round((lockProfit / totalInvestment) * 100)
      : 0;

    spots.push({
      rank,
      currentHolder: isVacant ? '(open)' : (holder?.player?.name ?? '?'),
      currentFP,
      lockCost: marginalCost,
      myFP,
      totalInvestment,
      rewardFP,
      baseRewardFP: rewards[index],
      lockProfit,
      profitPct,
    });
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
  const arcBonus = City.ArcBonus ?? 90;
  console.log('[NeighborGB] processGBRows — input rows:', (rowsData ?? []).length, 'ArcBonus:', arcBonus);

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

  console.log('[NeighborGB] processGBRows — activeRows (current_progress > 0):', activeRows.length);
  if (activeRows.length) {
    console.log('[NeighborGB] Active buildings:', activeRows.map(r => `${r.name} Lv${r.level} (${r.currentProgress}/${r.maxProgress})`).join(', '));
  } else {
    console.log('[NeighborGB] processGBRows — no buildings with active progress found');
    if ((rowsData ?? []).length) {
      const sample = rowsData[0];
      console.log('[NeighborGB] Sample row keys:', Object.keys(sample || {}));
      console.log('[NeighborGB] Sample row __class__:', sample?.__class__, 'entity_id:', sample?.entity_id, 'current_progress:', sample?.current_progress, 'player:', JSON.stringify(sample?.player));
    }
  }

  if (!activeRows.length) return [];

  const results = [];

  for (const row of activeRows) {
    const remaining =
      row.maxProgress != null ? row.maxProgress - row.currentProgress : null;
    let profitableSpots = [];

    // More accurate progress from the construction endpoint
    let accurateRemaining = remaining;
    let accurateProgress = row.currentProgress;
    let accurateMax = row.maxProgress;

    try {
      const constructionResponse = await getNeighborConstruction(
        row.entityId,
        row.playerId,
      );
      const construction = extractConstruction(constructionResponse);
      if (construction) {
        // Use construction data for more accurate progress if available
        const cp =
          construction.state?.current_progress ??
          construction.current_progress;
        const mp =
          construction.state?.max_progress ?? construction.max_progress;
        if (cp != null) accurateProgress = cp;
        if (mp != null) accurateMax = mp;
        if (accurateMax != null && accurateProgress != null) {
          accurateRemaining = accurateMax - accurateProgress;
        }

        const rankings = construction.rankings ?? [];
        if (rankings.length) {
          profitableSpots = calculateProfitableSpots(
            rankings,
            accurateRemaining,
            arcBonus,
          );
        }
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
      maxProgress: accurateMax ?? row.maxProgress,
      currentProgress: accurateProgress,
      remaining: accurateRemaining,
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
    const pct = progressPct(r.currentProgress, r.maxProgress);
    html +=
      `<div><strong>${r.name}</strong> Lv${r.level}: ` +
      `${r.currentProgress}/${r.maxProgress ?? '?'} FP (${pct}%)`;

    for (const spot of r.profitableSpots) {
      html +=
        `<div class="ms-2 text-success">🔒 P${spot.rank} ${spot.currentHolder}: ` +
        `${spot.lockCost}FP → ${spot.rewardFP}FP (${spot.lockProfit}FP profit, ${spot.profitPct}% ROI)</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  overview.innerHTML = html;
}

// Renders full-scan results (all neighbors) into gbScanDiv.
function showScanResults(profitable, scanned, total) {
  const arcBonus = City.ArcBonus ?? 90;
  const status =
    total > 0 ?
      `Scanned ${scanned}/${total} neighbors — ${profitable.length} building(s) with opportunities (Arc ${arcBonus}%)`
    : 'Scanning…';

  let html = `<div class="alert alert-warning alert-dismissible show" role="alert">
    ${element.close()}
    <p><strong>Hood GB Snipe Scanner</strong> — <small>${status}</small></p>`;

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
  const dedupedSpots = allSpots.filter(entry => {
    const key = `${entry.playerName}|${entry.name}|${entry.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (dedupedSpots.length) {
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>#</th><th>Player</th><th>Building</th><th>Progress</th><th>Rank</th>
        <th>Lock Cost</th><th>Reward</th><th>Profit</th><th>ROI</th>
      </tr></thead><tbody>`;

    for (const entry of dedupedSpots) {
      const { spot } = entry;
      const pct = entry.maxProgress > 0
        ? Math.round((entry.currentProgress / entry.maxProgress) * 100)
        : '?';
      html += `<tr>
        <td>${entry.hoodIndex ?? ''}</td>
        <td>${entry.playerName}</td>
        <td>${entry.name} Lv${entry.level}</td>
        <td>${pct}%</td>
        <td>#${spot.rank} ${spot.currentHolder}</td>
        <td>${spot.lockCost}</td>
        <td>${spot.rewardFP}</td>
        <td class="text-success">${spot.lockProfit}</td>
        <td>${spot.profitPct}%</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  } else if (scanned === total && total > 0) {
    html += `<p class="mb-0">No profitable spots found at your current Arc bonus (${arcBonus}%).</p>`;
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
  console.log('[NeighborGB] === SCAN BUTTON CLICKED ===');
  console.log('[NeighborGB] hoodlist length:', hoodlist.length);
  if (hoodlist.length) {
    console.log('[NeighborGB] hoodlist sample [0]:', JSON.stringify(hoodlist[0]));
  }

  if (!hoodlist.length) {
    console.warn('[NeighborGB] BAIL — hoodlist is empty');
    gbScanDiv.innerHTML = `<div class="alert alert-warning">Hood list not loaded — open the game's hood/social list first.</div>`;
    return;
  }

  const neighbors = hoodlist.filter(
    (e) => e.is_neighbor || e.hasOwnProperty('is_neighbor'),
  );
  const total = neighbors.length;
  const profitable = [];

  console.log('[NeighborGB] Starting full hood scan —', total, 'neighbors (filtered from', hoodlist.length, 'hoodlist entries)');
  if (total === 0) {
    console.warn('[NeighborGB] No entries with is_neighbor found. hoodlist keys sample:', Object.keys(hoodlist[0] || {}));
  }

  for (let i = 0; i < neighbors.length; i++) {
    const neighbor = neighbors[i];
    const playerId = neighbor.player_id;
    const playerName = neighbor.name ?? String(playerId);

    showScanResults(profitable, i, total);

    try {
      console.log('[NeighborGB] Scanning neighbor', i + 1, '/', total, ':', playerName, '(id:', playerId, ')');
      const overviewResponse = await getNeighborOverview(playerId);
      console.log('[NeighborGB] overviewResponse for', playerName, '— type:', typeof overviewResponse, 'is array:', Array.isArray(overviewResponse), 'length:', Array.isArray(overviewResponse) ? overviewResponse.length : 'N/A');
      const rows = extractGBRows(overviewResponse);
      console.log('[NeighborGB] GB rows for', playerName, ':', rows.length);
      const results = await processGBRows(rows);
      console.log('[NeighborGB] processGBRows results for', playerName, ':', results.length);

      for (const r of results) {
        if (r.profitableSpots.length) {
          profitable.push({
            playerName,
            hoodIndex: i + 1,
            name: r.name,
            level: r.level,
            currentProgress: r.currentProgress,
            maxProgress: r.maxProgress,
            remaining: r.remaining,
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

  // Sorting is handled in showScanResults (safe-lock first, then by profit)
  showScanResults(profitable, total, total);
  console.log(
    '[NeighborGB] Scan complete —',
    profitable.length,
    'profitable spots found',
  );
}

// Renders the "Scan Hood GBs" button and a readiness dashboard into gbScanDiv.
// Called once from index.js after the div is in the DOM.
export function initGBScanUI() {
  const btn = document.createElement('button');
  btn.id = 'gbScanBtn';
  btn.className = 'btn btn-sm btn-outline-warning mt-1 mb-1';
  btn.textContent = 'Scan Hood GBs';
  btn.disabled = true;
  btn.addEventListener('click', scanAllNeighborGBs);

  const statusDiv = document.createElement('div');
  statusDiv.id = 'gbScanStatus';
  statusDiv.className = 'small text-muted mb-1';
  statusDiv.style.lineHeight = '1.4';

  gbScanDiv.appendChild(btn);
  gbScanDiv.appendChild(statusDiv);

  // Kick off secret discovery in the background so it's ready when needed
  tryDiscoverSecret().catch(() => {});

  // Periodic readiness check — updates every 2 s until all prerequisites are met
  const checkInterval = setInterval(() => {
    const ready = updateScanReadiness(btn, statusDiv);
    if (ready) clearInterval(checkInterval);
  }, 2000);
  // Run once immediately
  updateScanReadiness(btn, statusDiv);
}

function updateScanReadiness(btn, statusDiv) {
  const checks = [
    { label: 'Hood list', ok: hoodlist.length > 0, detail: hoodlist.length > 0 ? `${hoodlist.length} players` : 'open social bar' },
    { label: 'Game URL', ok: !!gameJsonUrl, detail: gameJsonUrl ? 'captured' : 'waiting for game traffic' },
    { label: 'Request ID', ok: gameRequestId > 0, detail: gameRequestId > 0 ? `#${gameRequestId}` : 'waiting for game traffic' },
    { label: 'Player ID', ok: !!PlayerID, detail: PlayerID ? `${PlayerID}` : 'waiting for login data' },
    { label: 'Arc bonus', ok: City.ArcBonus != null, detail: City.ArcBonus != null ? `${City.ArcBonus}%` : 'defaults to 90%' },
    { label: 'Secret key', ok: isSecretDiscovered(), detail: isSecretDiscovered() ? 'discovered' : 'auto-discovers on first scan' },
  ];

  // Core prerequisites that must be met to enable the button
  const coreReady = checks[0].ok && checks[1].ok && checks[2].ok;

  btn.disabled = !coreReady;
  btn.className = coreReady
    ? 'btn btn-sm btn-warning mt-1 mb-1'
    : 'btn btn-sm btn-outline-secondary mt-1 mb-1';

  const lines = checks.map(c => {
    const icon = c.ok ? '✅' : (c.label === 'Arc bonus' || c.label === 'Secret key' ? '⏳' : '❌');
    return `${icon} ${c.label}: ${c.detail}`;
  });
  statusDiv.innerHTML = lines.join('<br>');

  const allReady = checks.every(c => c.ok);
  return allReady;
}
