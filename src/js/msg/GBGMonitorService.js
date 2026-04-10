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
 * GBG Monitor — Active province monitoring with Discord alerts.
 *
 * Polls getBattleground every 15–30 seconds (randomized), diffs province
 * state against the previous snapshot, and fires Discord webhook alerts for:
 *   - Our province being attacked (new or increased conquestProgress)
 *   - Province lock about to expire (configurable threshold)
 *   - Province ownership changes
 *   - New attacks anywhere on the grid
 *
 * Uses the shared transport layer from NeighborGBService.js.
 */

import {
  targets,
  VolcanoProvinceDefs,
  WaterfallProvinceDefs,
  gameJsonUrl,
  gameRequestId,
  url,
  EpocTime,
} from '../index.js';
import { postGameRequest } from './NeighborGBService.js';
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
let pollTimerId = null;
let isMonitoring = false;
let monitorDiv = null;
let lastAlerts = new Map(); // key → timestamp for debounce

// Configurable thresholds
const LOCK_WARN_MINUTES = 5;
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
  return def?.name ?? `Province ${provinceId}`;
}

function randomPollDelay() {
  return (Math.floor(Math.random() * 16) + 15) * 1000;
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

    // --- New or increased attacks ---
    for (const cp of newProv.conquestProgress ?? []) {
      const oldCp = oldProv?.conquestProgress?.find(
        (o) => o.participantId === cp.participantId,
      );
      const attackerName = getParticipantName(cp.participantId);
      const pct = Math.round((cp.progress / cp.maxProgress) * 100);

      if (!oldCp) {
        // New attack
        if (weOwn) {
          alerts.push({
            type: 'under_attack',
            key: `attack-${newProv.id}-${cp.participantId}`,
            emoji: '🔴',
            message: `🔴 **${provName} UNDER ATTACK** by ${attackerName} (${cp.progress}/${cp.maxProgress}, ${pct}%)`,
          });
        } else {
          alerts.push({
            type: 'new_attack',
            key: `attack-${newProv.id}-${cp.participantId}`,
            emoji: '⚔️',
            message: `⚔️ New attack on ${provName} (${getParticipantName(newProv.ownerId)}) by ${attackerName} (${cp.progress}/${cp.maxProgress}, ${pct}%)`,
          });
        }
      } else if (cp.progress > oldCp.progress) {
        // Attack progressed
        if (weOwn && pct >= 50) {
          alerts.push({
            type: 'attack_progress',
            key: `attack-prog-${newProv.id}-${cp.participantId}-${Math.floor(pct / 25) * 25}`,
            emoji: '🔴',
            message: `🔴 **${provName} attack at ${pct}%** by ${attackerName} (${cp.progress}/${cp.maxProgress})`,
          });
        }
      }
    }

    // --- Lock expiring soon ---
    if (weOwn && newProv.lockedUntil) {
      const secsLeft = newProv.lockedUntil - now;
      if (secsLeft > 0 && secsLeft <= LOCK_WARN_MINUTES * 60) {
        alerts.push({
          type: 'lock_expiring',
          key: `lock-${newProv.id}`,
          emoji: '🟡',
          message: `🟡 **${provName} lock expires in ${formatCountdown(secsLeft)}**`,
        });
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
// Polling
// ---------------------------------------------------------------------------

async function pollBattleground() {
  if (!isMonitoring) return;

  try {
    console.log('[GBGMonitor] Polling getBattleground...');
    const response = await postGameRequest([
      {
        __class__: 'ServerRequest',
        requestData: [],
        requestClass: 'GuildBattlegroundService',
        requestMethod: 'getBattleground',
      },
    ]);

    // Extract the getBattleground response from the array
    if (Array.isArray(response)) {
      const bgMsg = response.find(
        (r) =>
          r?.requestClass === 'GuildBattlegroundService' &&
          r?.requestMethod === 'getBattleground' &&
          r?.responseData,
      );
      if (bgMsg) {
        onBattlegroundUpdate(bgMsg.responseData);
      }
    }
  } catch (err) {
    console.warn('[GBGMonitor] Poll failed:', err.message);
  }

  // Schedule next poll with random delay
  if (isMonitoring) {
    pollTimerId = setTimeout(pollBattleground, randomPollDelay());
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

  // Update the UI
  renderMonitorUI();
}

// ---------------------------------------------------------------------------
// Monitoring control
// ---------------------------------------------------------------------------

export function startMonitoring() {
  if (isMonitoring) return;
  isMonitoring = true;
  console.log('[GBGMonitor] Monitoring started');
  updateMonitorButton();
  pollBattleground();
}

export function stopMonitoring() {
  isMonitoring = false;
  if (pollTimerId) {
    clearTimeout(pollTimerId);
    pollTimerId = null;
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

  // Separate our provinces into categories
  const ourProvinces = currentMap.filter(
    (p) => p.ownerId === ourParticipantId && !p.isSpawnSpot,
  );
  const underAttack = ourProvinces.filter(
    (p) => p.conquestProgress?.length > 0,
  );
  const allAttacks = currentMap.filter((p) => p.conquestProgress?.length > 0);

  let html = `<div class="alert alert-info alert-dismissible show" role="alert">
    ${element.close()}
    <p><strong>GBG Monitor</strong>
    <small class="text-muted ms-2">${isMonitoring ? '🟢 Active' : '🔴 Stopped'} | ${ourProvinces.length} provinces held</small></p>`;

  // Under attack section
  if (underAttack.length) {
    html += `<p class="mb-1"><strong class="text-danger">⚠ Our Provinces Under Attack:</strong></p>`;
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

  // Our provinces with lock timers
  if (ourProvinces.length) {
    html += `<p class="mb-1"><strong>Our Provinces:</strong></p>`;
    html += `<table class="table table-sm table-borderless mb-2" id="gbgMonitorOurTable">
      <thead><tr><th>Province</th><th>VP</th><th>VP Bonus</th><th>Lock</th><th>Attrition %</th></tr></thead><tbody>`;
    const sorted = [...ourProvinces].sort(
      (a, b) => (a.lockedUntil ?? 0) - (b.lockedUntil ?? 0),
    );
    for (const p of sorted) {
      const lockSecs = p.lockedUntil ? p.lockedUntil - now : 0;
      const lockText =
        !p.lockedUntil ? '🔓 Open'
        : lockSecs <= 0 ? '🔓 Open'
        : lockSecs <= LOCK_WARN_MINUTES * 60 ? `⚠️ ${formatCountdown(lockSecs)}`
        : formatCountdown(lockSecs);
      const isAttacked = p.conquestProgress?.length > 0;
      const rowClass =
        isAttacked ? 'table-danger'
        : lockSecs <= 0 ? 'table-warning'
        : '';
      html += `<tr class="${rowClass}">
        <td>${getProvinceName(p.id)}</td>
        <td>${p.victoryPoints ?? 0}</td>
        <td>${p.victoryPointsBonus ?? 0}</td>
        <td>${lockText}</td>
        <td>${p.gainAttritionChance ?? 0}%</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  // All active attacks on the grid
  if (allAttacks.length) {
    html += `<p class="mb-1"><strong>All Active Attacks:</strong></p>`;
    html += `<table class="table table-sm table-borderless mb-2" id="gbgMonitorAttacksTable">
      <thead><tr><th>Province</th><th>Defender</th><th>Attacker</th><th>Progress</th><th>%</th></tr></thead><tbody>`;
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
  const hasUrl = !!gameJsonUrl;
  const hasId = gameRequestId > 0;
  const hasWebhook = !!(url.discordGBGURL || url.discordTargetURL);

  const checks = [
    {
      label: 'Game URL',
      ok: hasUrl,
      detail: hasUrl ? 'captured' : 'waiting for game traffic',
    },
    {
      label: 'Request ID',
      ok: hasId,
      detail: hasId ? `#${gameRequestId}` : 'waiting',
    },
    {
      label: 'Discord webhook',
      ok: hasWebhook,
      detail: hasWebhook ? 'configured' : 'set in options (optional)',
    },
  ];

  const coreReady = hasUrl && hasId;
  if (!isMonitoring) {
    btn.disabled = !coreReady;
    btn.className =
      coreReady ?
        'btn btn-sm btn-info mt-1 mb-1'
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
