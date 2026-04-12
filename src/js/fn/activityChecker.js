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

// Checks player activity via foe.scoredb.io score history.
// Active = score changed in the last 7 days (or 30 days if <7 data points).
// Results are cached per player with TTL (24h active, 6h inactive/unknown).

const ACTIVE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const INACTIVE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT = 8000; // 8 seconds per request
const CONCURRENCY = 5;

// Cache: playerId → { active: bool|null, delta7d, delta30d, ts }
const cache = new Map();

// Extract FoE server from the game URL (e.g. "us11" from "https://us11.forgeofempires.com/...")
export function detectServer(gameJsonUrl) {
  if (!gameJsonUrl) return null;
  try {
    const hostname = new URL(gameJsonUrl).hostname;
    const server = hostname.split('.')[0];
    return server ? server.toUpperCase() : null;
  } catch {
    return null;
  }
}

// Parse the data-counters attribute to get score history for the target player.
// Returns array of daily scores, newest first, or null on failure.
function parseScoreHistory(html) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Bail on error pages
    const title = doc.querySelector('title')?.textContent ?? '';
    if (/error/i.test(title)) return null;

    const el = doc.querySelector('#playerPoints[data-counters]');
    if (!el) return null;

    const counters = el.getAttribute('data-counters');
    if (!counters) return null;

    // First comma-separated series = the target player
    const firstSeries = counters.split(',')[0];
    if (!firstSeries) return null;

    const scores = firstSeries.split('|').map(Number);
    if (scores.length === 0 || scores.some(isNaN)) return null;

    return scores;
  } catch {
    return null;
  }
}

// Determine activity from score history.
// Returns { active: bool|null, delta7d: number|null, delta30d: number|null }
function analyzeActivity(scores) {
  if (!scores || scores.length < 2) {
    return { active: null, delta7d: null, delta30d: null };
  }

  const newest = scores[0];
  const delta30d = newest - scores[scores.length - 1];

  // 7-day check: compare index 0 vs index 6 (if available)
  const day7Index = Math.min(6, scores.length - 1);
  const delta7d = newest - scores[day7Index];

  // Active if score changed in either window
  const active = delta7d !== 0 || delta30d !== 0;

  return { active, delta7d, delta30d };
}

// Fetch a single player's activity from scoredb.io
async function fetchPlayerActivity(playerId, server) {
  const url = `https://foe.scoredb.io/${server}/Player/${playerId}/Overview`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { active: null, delta7d: null, delta30d: null };

    const html = await resp.text();
    const scores = parseScoreHistory(html);
    return analyzeActivity(scores);
  } catch {
    return { active: null, delta7d: null, delta30d: null };
  } finally {
    clearTimeout(timeout);
  }
}

// Run tasks with a concurrency limit
async function pooledMap(items, fn, limit) {
  const results = new Map();
  const queue = [...items];
  const workers = [];

  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          results.set(item, await fn(item));
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

// Check activity for a batch of player IDs.
// Returns Map<playerId, { active: bool|null, delta7d, delta30d }>
// Cached results are reused; only uncached players are fetched.
export async function checkPlayersActivity(playerIds, server, onProgress) {
  const results = new Map();
  const toFetch = [];
  const now = Date.now();

  for (const id of playerIds) {
    const cached = cache.get(id);
    if (cached) {
      const ttl = cached.active === false ? INACTIVE_TTL : ACTIVE_TTL;
      if (now - cached.ts < ttl) {
        results.set(id, cached);
        continue;
      }
    }
    toFetch.push(id);
  }

  if (!server || toFetch.length === 0) {
    // Fill missing with null (unknown = treat as active)
    for (const id of toFetch) {
      results.set(id, { active: null, delta7d: null, delta30d: null });
    }
    return results;
  }

  let done = 0;
  const fetchResults = await pooledMap(
    toFetch,
    async (id) => {
      const result = await fetchPlayerActivity(id, server);
      done++;
      onProgress?.(done, toFetch.length);
      return result;
    },
    CONCURRENCY,
  );

  for (const [id, result] of fetchResults) {
    const entry = { ...result, ts: now };
    cache.set(id, entry);
    results.set(id, entry);
  }

  return results;
}
