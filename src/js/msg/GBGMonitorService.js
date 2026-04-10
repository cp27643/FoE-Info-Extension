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
 * GBG Monitor — Passive province monitoring with Discord alerts.
 *
 * Listens for WebSocket messages pushed by the game server via the
 * wsProxy.js content script. Province updates arrive in real-time
 * without any outgoing requests to the game server.
 *
 * Initial full state comes from the XHR getBattleground response
 * (intercepted by index.js). Subsequent incremental updates come
 * via WebSocket and are merged into the current map state.
 */

import {
  targets,
  VolcanoProvinceDefs,
  WaterfallProvinceDefs,
  url,
  EpocTime,
} from '../index.js';
import * as element from '../fn/AddElement';
import { makeSortable } from '../fn/sortableTable.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let previousMap = [];
let currentMap = [];
let participants = [];
let ourParticipantId = 0;
let provinceDefs = [];
let wsListenerTimerId = null;
let isMonitoring = false;
let monitorDiv = null;
let lastAlerts = new Map(); // key → timestamp for debounce
let lastTargetText = ''; // track target generator output for change detection
let activeFilter = null; // null = show all, or 'ours'|'attack'|'unlocked'

// Configurable thresholds
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min debounce per event

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getParticipantName(participantId) {
  const p = participants.find((c) => c.participantId === participantId);
  return p?.clan?.name ?? `Guild#${participantId}`;
}

function getProvinceName(provinceId) {
  const def = provinceDefs.find((d) => d.id === provinceId);
  if (!def?.name) return `P${provinceId}`;
  // Short format: "A3: Z" from "A3: Zamva" or "A3 Zamva"
  const match = def.name.match(/^(\w+):?\s+(\w)/);
  if (match) return `${match[1]}: ${match[2]}`;
  return def.name.split(' ')[0].replace(/:$/, '');
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return 'NOW';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// Debounce: returns true if this alert key should fire (hasn't fired recently)
function shouldAlert(key) {
  const last = lastAlerts.get(key);
  const now = Date.now();
  if (last && now - last < ALERT_COOLDOWN_MS) return false;
  lastAlerts.set(key, now);
  return true;
}

// ---------------------------------------------------------------------------
// Discord webhook
// ---------------------------------------------------------------------------

function sendDiscordAlert(message) {
  const webhookUrl = url.discordGBGURL || url.discordTargetURL;
  if (!webhookUrl) {
    console.log('[GBGMonitor] No Discord webhook URL configured');
    return;
  }

  const params = {
    username: 'FoE-Info GBG Monitor',
    content: message,
  };

  const oReq = new XMLHttpRequest();
  oReq.open('POST', webhookUrl, true);
  oReq.setRequestHeader('Content-type', 'application/json');
  oReq.onreadystatechange = function () {
    if (oReq.readyState === 4 && oReq.status >= 400) {
      console.warn('[GBGMonitor] Discord webhook error:', oReq.status);
    }
  };
  oReq.send(JSON.stringify(params));
  console.log('[GBGMonitor] Discord alert sent:', message);
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

function diffProvinces(oldMap, newMap) {
  const alerts = [];
  const now = nowEpoch();

  for (const newProv of newMap) {
    const oldProv = oldMap.find((p) => p.id === newProv.id);
    const provName = getProvinceName(newProv.id);
    const weOwn = newProv.ownerId === ourParticipantId;

    // --- Ownership change ---
    if (oldProv && oldProv.ownerId !== newProv.ownerId) {
      const oldOwner = getParticipantName(oldProv.ownerId);
      const newOwner = getParticipantName(newProv.ownerId);
      if (oldProv.ownerId === ourParticipantId) {
        alerts.push({
          type: 'lost',
          key: `lost-${newProv.id}`,
          emoji: '🔴',
          message: `🔴 **LOST ${provName}** — taken by ${newOwner}`,
        });
      } else if (newProv.ownerId === ourParticipantId) {
        alerts.push({
          type: 'captured',
          key: `captured-${newProv.id}`,
          emoji: '🟢',
          message: `🟢 **CAPTURED ${provName}** from ${oldOwner}`,
        });
      } else {
        alerts.push({
          type: 'ownership',
          key: `ownership-${newProv.id}`,
          emoji: '🔄',
          message: `🔄 ${provName} changed: ${oldOwner} → ${newOwner}`,
        });
      }
    }

    // --- Opportunity: another guild attacking a province we don't own ---
    for (const cp of newProv.conquestProgress ?? []) {
      const oldCp = oldProv?.conquestProgress?.find(
        (o) => o.participantId === cp.participantId,
      );
      const attackerName = getParticipantName(cp.participantId);
      const pct = Math.round((cp.progress / cp.maxProgress) * 100);
      const weAreAttacking = cp.participantId === ourParticipantId;

      // Only alert on provinces we don't own AND we aren't the attacker
      if (!weOwn && !weAreAttacking && cp.progress > (oldCp?.progress ?? 0)) {
        // Fire at 10%, 50%, and 75% thresholds
        const threshold =
          pct >= 75 ? 75
          : pct >= 50 ? 50
          : pct >= 10 ? 10
          : 0;
        const oldPct =
          oldCp ? Math.round((oldCp.progress / oldCp.maxProgress) * 100) : 0;
        const oldThreshold =
          oldPct >= 75 ? 75
          : oldPct >= 50 ? 50
          : oldPct >= 10 ? 10
          : 0;

        if (threshold > 0 && threshold > oldThreshold) {
          const defenderName = getParticipantName(newProv.ownerId);
          alerts.push({
            type: 'opportunity',
            key: `opp-${newProv.id}-${cp.participantId}-${threshold}`,
            emoji: '🎯',
            message: `🎯 **OPPORTUNITY: ${provName}** — ${attackerName} attacking ${defenderName} at ${pct}% (${cp.progress}/${cp.maxProgress})`,
          });
        }
      }
    }

    // --- Province just unlocked ---
    if (oldProv?.lockedUntil && !newProv.lockedUntil) {
      alerts.push({
        type: 'unlocked',
        key: `unlocked-${newProv.id}`,
        emoji: '🔓',
        message: `🔓 ${provName} (${getParticipantName(newProv.ownerId)}) is now unlocked`,
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// WebSocket listener — drains messages queued by wsProxy.js content script
// ---------------------------------------------------------------------------

const WS_DRAIN_INTERVAL = 2000; // check every 2 seconds

function drainWsMessages() {
  if (!isMonitoring) return;

  chrome.devtools.inspectedWindow.eval(
    `(function() {
      var q = window.__foeInfoWsMessages;
      if (!q || !q.length) return null;
      var msgs = q.splice(0, q.length);
      return JSON.stringify(msgs);
    })()`,
    (result, isException) => {
      if (isException || !result) {
        scheduleNextDrain();
        return;
      }

      try {
        const messages = JSON.parse(result);
        processWsMessages(messages);
      } catch (e) {
        console.warn('[GBGMonitor] Failed to parse WS messages:', e);
      }

      scheduleNextDrain();
    },
  );
}

function scheduleNextDrain() {
  if (isMonitoring) {
    wsListenerTimerId = setTimeout(drainWsMessages, WS_DRAIN_INTERVAL);
  }
}

function processWsMessages(messages) {
  if (!currentMap.length) return; // no base state yet

  let changed = false;

  for (const msg of messages) {
    if (!msg?.responseData) continue;

    const className = msg.requestClass || '';
    const method = msg.requestMethod || '';

    console.log('[GBGMonitor] WS:', className + '.' + method);

    // Full state refresh (rare via WS, but handle it)
    if (
      className === 'GuildBattlegroundService' &&
      method === 'getBattleground' &&
      msg.responseData?.map?.provinces
    ) {
      onBattlegroundUpdate(msg.responseData);
      return;
    }

    // Incremental province update — merge delta into current map
    // responseData is an array with [{id, ...changed properties}]
    const updates = Array.isArray(msg.responseData)
      ? msg.responseData
      : [msg.responseData];

    for (const update of updates) {
      if (!update || typeof update.id === 'undefined') continue;

      const province = currentMap.find((p) => p.id === update.id);
      if (!province) continue;

      // Snapshot the province before applying updates for diffing
      const oldSnapshot = JSON.parse(JSON.stringify(province));

      // Merge changed properties
      for (const key of Object.keys(update)) {
        if (key === 'id') continue;
        province[key] = update[key];
      }

      // Diff this single province change
      const alerts = diffProvinces([oldSnapshot], [province]);
      for (const alert of alerts) {
        if (shouldAlert(alert.key)) {
          sendDiscordAlert(alert.message);
        }
      }

      changed = true;
    }
  }

  if (changed) {
    // Check if target generator output changed
    setTimeout(checkTargetChange, 500);
    renderMonitorUI();
  }
}

// ---------------------------------------------------------------------------
// Target generator change detection
// ---------------------------------------------------------------------------

function checkTargetChange() {
  const el = document.getElementById('targetGenText');
  if (!el) return;

  // Extract only stable row data (province names) — ignore timer columns
  const rows = el.querySelectorAll('tr');
  const stableKeys = [];
  const rowTexts = [];
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 3) continue;
    // columns: Battle(0), Province(1), Attrition(2), Opens In(3), SC(4), Built In(5)
    // Only use Province as the stable key — the rest can change with timers or SC updates
    const province = cells[1]?.textContent?.trim() ?? '';
    if (province) {
      stableKeys.push(province);
      // Capture full row for Discord message
      const battle = cells[0]?.textContent?.trim() ?? '';
      const attrition = cells[2]?.textContent?.trim() ?? '';
      rowTexts.push(`${battle} | ${province} | ${attrition}`);
    }
  }

  const currentSignature = stableKeys.sort().join('|');
  if (!currentSignature) return;

  // Skip first capture (baseline)
  if (!lastTargetText) {
    lastTargetText = currentSignature;
    return;
  }

  if (currentSignature !== lastTargetText) {
    // Determine what's new
    const oldSet = new Set(lastTargetText.split('|'));
    const newTargets = stableKeys.filter((k) => !oldSet.has(k));
    const removedTargets = [...oldSet].filter(
      (k) => k && !stableKeys.includes(k),
    );
    lastTargetText = currentSignature;

    if (
      (newTargets.length > 0 || removedTargets.length > 0) &&
      shouldAlert('target-change')
    ) {
      let msg = '📋 **GBG Targets Changed:**\n';
      if (newTargets.length > 0) {
        msg += `🆕 Added: ${newTargets.join(', ')}\n`;
      }
      if (removedTargets.length > 0) {
        msg += `❌ Removed: ${removedTargets.join(', ')}\n`;
      }
      msg += `\n**Current targets (${rowTexts.length}):**\n`;
      msg += rowTexts.join('\n');
      sendDiscordAlert(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Public: process a getBattleground responseData
// ---------------------------------------------------------------------------

export function onBattlegroundUpdate(responseData) {
  const mapId = responseData?.map?.id ?? '';
  const mapType = mapId.split('_')[0];

  if (mapType === 'volcano') provinceDefs = VolcanoProvinceDefs;
  else if (mapType === 'waterfall') provinceDefs = WaterfallProvinceDefs;

  ourParticipantId = responseData.currentParticipantId ?? ourParticipantId;
  participants = responseData.battlegroundParticipants ?? participants;

  previousMap = currentMap;
  currentMap = responseData.map?.provinces ?? [];

  // Diff and alert (skip first load — no previous data to diff against)
  if (previousMap.length > 0) {
    const alerts = diffProvinces(previousMap, currentMap);
    for (const alert of alerts) {
      if (shouldAlert(alert.key)) {
        sendDiscordAlert(alert.message);
      }
    }
  }

  // Check if target generator output changed (short delay for DOM update)
  setTimeout(checkTargetChange, 500);

  // Auto-start WS monitoring when we receive battleground data
  if (!isMonitoring) {
    startMonitoring();
  }

  // Update the UI
  renderMonitorUI();
}

// ---------------------------------------------------------------------------
// Monitoring control
// ---------------------------------------------------------------------------

export function startMonitoring() {
  if (isMonitoring) return;
  isMonitoring = true;
  console.log('[GBGMonitor] Monitoring started (WebSocket listener)');
  updateMonitorButton();
  drainWsMessages();
}

export function stopMonitoring() {
  isMonitoring = false;
  if (wsListenerTimerId) {
    clearTimeout(wsListenerTimerId);
    wsListenerTimerId = null;
  }
  console.log('[GBGMonitor] Monitoring stopped');
  updateMonitorButton();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateMonitorButton() {
  const btn = monitorDiv?.querySelector('#gbgMonitorBtn');
  if (!btn) return;
  btn.textContent =
    isMonitoring ? '⏹ Stop GBG Monitor' : '▶ Start GBG Monitor';
  btn.className =
    isMonitoring ?
      'btn btn-sm btn-danger mt-1 mb-1'
    : 'btn btn-sm btn-outline-info mt-1 mb-1';
}

function renderMonitorUI() {
  if (!monitorDiv) return;
  const now = nowEpoch();

  // Separate our provinces into categories (include spawn spot in count)
  const ourProvinces = currentMap.filter((p) => p.ownerId === ourParticipantId);
  const ourNonSpawn = ourProvinces.filter((p) => !p.isSpawnSpot);
  const underAttack = ourNonSpawn.filter((p) => p.conquestProgress?.length > 0);
  const allAttacks = currentMap.filter((p) => p.conquestProgress?.length > 0);

  let html = `<div class="alert alert-info alert-dismissible show" role="alert">
    ${element.close()}
    <p><strong>GBG Monitor</strong>
    <small class="text-muted ms-2">${isMonitoring ? '🟢 Active' : '🔴 Stopped'} | ${ourProvinces.length} provinces held</small></p>
    <p class="mb-1 small">Filter:
      <span class="badge bg-success text-white gbg-filter" data-filter="ours" role="button" style="cursor:pointer;${activeFilter === 'ours' ? 'outline:2px solid #000;' : 'opacity:0.6;'}">Ours</span>
      <span class="badge bg-danger text-white gbg-filter" data-filter="attack" role="button" style="cursor:pointer;${activeFilter === 'attack' ? 'outline:2px solid #000;' : 'opacity:0.6;'}">Under Attack</span>
      <span class="badge bg-warning text-dark gbg-filter" data-filter="unlocked" role="button" style="cursor:pointer;${activeFilter === 'unlocked' ? 'outline:2px solid #000;' : 'opacity:0.6;'}">Unlocked (not ours)</span>
      ${activeFilter ? '<span class="badge bg-secondary text-white gbg-filter" data-filter="clear" role="button" style="cursor:pointer;">✕ Clear</span>' : ''}
    </p>`;

  // Under attack section
  if (underAttack.length) {
    html += `<p class="mb-1"><strong class="text-danger">⚠ Our Provinces Under Attack (${underAttack.length}):</strong></p>`;
    html += `<table class="table table-sm table-borderless mb-2">
      <thead><tr><th>Province</th><th>Attacker</th><th>Progress</th><th>%</th></tr></thead><tbody>`;
    for (const p of underAttack) {
      for (const cp of p.conquestProgress) {
        const pct = Math.round((cp.progress / cp.maxProgress) * 100);
        const rowClass =
          pct >= 75 ? 'table-danger'
          : pct >= 50 ? 'table-warning'
          : '';
        html += `<tr class="${rowClass}">
          <td>${getProvinceName(p.id)}</td>
          <td>${getParticipantName(cp.participantId)}</td>
          <td>${cp.progress}/${cp.maxProgress}</td>
          <td>${pct}%</td>
        </tr>`;
      }
    }
    html += `</tbody></table>`;
  }

  // All provinces table
  const allProvinces = currentMap.filter((p) => !p.isSpawnSpot);
  if (allProvinces.length) {
    html += `<p class="mb-1"><strong>All Provinces (${allProvinces.length}):</strong></p>`;
    html += `<table class="table table-sm table-borderless mb-2" id="gbgMonitorAllTable">
      <thead><tr><th>Province</th><th>Owner</th><th>VP</th><th>VP Bonus</th><th>Lock</th><th>Attrition</th></tr></thead><tbody>`;
    const sorted = [...allProvinces].sort(
      (a, b) => (a.lockedUntil ?? 0) - (b.lockedUntil ?? 0),
    );
    for (const p of sorted) {
      const lockSecs = p.lockedUntil ? p.lockedUntil - now : 0;
      const lockText =
        !p.lockedUntil ? '🔓 Open'
        : lockSecs <= 0 ? '🔓 Open'
        : lockSecs <= LOCK_WARN_MINUTES * 60 ? `⚠️ ${formatCountdown(lockSecs)}`
        : formatCountdown(lockSecs);
      const isOurs = p.ownerId === ourParticipantId;
      const isAttacked = p.conquestProgress?.length > 0;
      const isUnlocked = !p.lockedUntil || lockSecs <= 0;
      const category =
        isAttacked && isOurs ? 'attack'
        : isOurs ? 'ours'
        : isUnlocked ? 'unlocked'
        : 'other';
      const rowClass =
        category === 'attack' ? 'table-danger'
        : category === 'ours' ? 'table-success'
        : category === 'unlocked' ? 'table-warning'
        : '';
      const hidden =
        activeFilter && activeFilter !== category ?
          ' style="display:none;"'
        : '';
      html += `<tr class="${rowClass}" data-category="${category}"${hidden}>
        <td>${getProvinceName(p.id)}</td>
        <td>${getParticipantName(p.ownerId)}</td>
        <td>${p.victoryPoints ?? 0}</td>
        <td>${p.victoryPointsBonus ?? 0}</td>
        <td>${lockText}</td>
        <td>${p.gainAttritionChance ?? '—'}%</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  // All active attacks on the grid
  if (allAttacks.length) {
    html += `<p class="mb-1"><strong>All Active Attacks:</strong> <small class="text-muted">(<span class="text-danger">red</span> = our province)</small></p>`;
    html += `<table class="table table-sm table-borderless mb-2" id="gbgMonitorAttacksTable">
      <thead><tr><th>Province</th><th>Defender</th><th>Attacker</th><th>Progress</th><th>%</th><th>Attrition</th></tr></thead><tbody>`;
    for (const p of allAttacks) {
      for (const cp of p.conquestProgress) {
        const pct = Math.round((cp.progress / cp.maxProgress) * 100);
        const isOurs = p.ownerId === ourParticipantId;
        const rowClass = isOurs ? 'table-danger' : '';
        html += `<tr class="${rowClass}">
          <td>${getProvinceName(p.id)}</td>
          <td>${getParticipantName(p.ownerId)}</td>
          <td>${getParticipantName(cp.participantId)}</td>
          <td>${cp.progress}/${cp.maxProgress}</td>
          <td>${pct}%</td>
          <td>${p.gainAttritionChance ?? '—'}%</td>
        </tr>`;
      }
    }
    html += `</tbody></table>`;
  }

  html += `</div>`;

  // Preserve the button
  const btn = monitorDiv.querySelector('#gbgMonitorBtn');
  const statusEl = monitorDiv.querySelector('#gbgMonitorStatus');
  monitorDiv.innerHTML = '';
  if (btn) monitorDiv.appendChild(btn);
  if (statusEl) monitorDiv.appendChild(statusEl);

  const resultsDiv = document.createElement('div');
  resultsDiv.innerHTML = html;
  monitorDiv.appendChild(resultsDiv);

  // Make tables sortable
  const tables = monitorDiv.querySelectorAll('table');
  tables.forEach((tbl) => makeSortable(tbl));

  // Wire up filter badge clicks
  monitorDiv.querySelectorAll('.gbg-filter').forEach((badge) => {
    badge.addEventListener('click', () => {
      const filter = badge.dataset.filter;
      activeFilter =
        filter === 'clear' || activeFilter === filter ? null : filter;
      renderMonitorUI();
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initGBGMonitorUI(containerDiv) {
  monitorDiv = containerDiv;

  const btn = document.createElement('button');
  btn.id = 'gbgMonitorBtn';
  btn.className = 'btn btn-sm btn-outline-info mt-1 mb-1';
  btn.textContent = '▶ Start GBG Monitor';
  btn.addEventListener('click', () => {
    if (isMonitoring) stopMonitoring();
    else startMonitoring();
  });

  const statusDiv = document.createElement('div');
  statusDiv.id = 'gbgMonitorStatus';
  statusDiv.className = 'small text-muted mb-1';

  monitorDiv.appendChild(btn);
  monitorDiv.appendChild(statusDiv);

  // Readiness check
  const checkInterval = setInterval(() => {
    const ready = updateMonitorReadiness(btn, statusDiv);
    if (ready) clearInterval(checkInterval);
  }, 2000);
  updateMonitorReadiness(btn, statusDiv);
}

function updateMonitorReadiness(btn, statusDiv) {
  const hasData = currentMap.length > 0;
  const hasWebhook = !!(url.discordGBGURL || url.discordTargetURL);

  const checks = [
    {
      label: 'GBG data',
      ok: hasData,
      detail: hasData
        ? `${currentMap.length} provinces loaded`
        : 'open GBG map in-game to load data',
    },
    {
      label: 'Discord webhook',
      ok: hasWebhook,
      detail: hasWebhook ? 'configured' : 'set in options (optional)',
    },
  ];

  const coreReady = hasData;
  if (!isMonitoring) {
    btn.disabled = !coreReady;
    btn.className =
      coreReady
        ? 'btn btn-sm btn-info mt-1 mb-1'
        : 'btn btn-sm btn-outline-secondary mt-1 mb-1';
  }

  const lines = checks.map((c) => {
    const icon =
      c.ok ? '✅'
      : c.label === 'Discord webhook' ? '⏳'
      : '❌';
    return `${icon} ${c.label}: ${c.detail}`;
  });
  statusDiv.innerHTML = lines.join('<br>');

  return checks.every((c) => c.ok);
}
