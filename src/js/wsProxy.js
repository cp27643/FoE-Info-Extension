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
 * WebSocket proxy — runs as a MAIN-world content script at document_start.
 *
 * Monkey-patches WebSocket.prototype.send so that the first time any
 * WebSocket instance sends a message, we attach a 'message' listener.
 *
 * Provides passive interception only — GBG Battleground messages are
 * pushed into __foeInfoWsMessages for the GBG monitor to consume.
 *
 * This file must remain plain vanilla JS — no imports, no webpack, no ES modules.
 */

(function () {
  'use strict';

  if (window.__foeInfoWsProxyInstalled) return;
  window.__foeInfoWsProxyInstalled = true;

  // ── Passive interception queue ────────────────────────────────────────────
  // GBG messages for the monitor
  window.__foeInfoWsMessages = [];

  // ── Shared state ──────────────────────────────────────────────────────────
  var gameSocket = null;
  var observedSockets = new WeakSet();
  var originalWsSend = WebSocket.prototype.send;

  // ── Incoming WS message handler ─────────────────────────────────────────
  function onWsMessage(evt) {
    try {
      if (evt.data === 'PONG' || evt.data === 'PING') return;

      var data = JSON.parse(evt.data);
      var messages = Array.isArray(data) ? data : [data];

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg || !msg.requestClass) continue;

        // GBG monitor: capture Battleground messages
        if (msg.requestClass.indexOf('Battleground') !== -1) {
          window.__foeInfoWsMessages.push(msg);
        }
      }
    } catch (e) {
      // Ignore non-JSON WebSocket messages
    }
  }

  // ── Outgoing WS message hook ────────────────────────────────────────────
  WebSocket.prototype.send = function (data) {
    // Capture the game's WebSocket reference
    if (!observedSockets.has(this)) {
      observedSockets.add(this);
      gameSocket = this;
      this.addEventListener('message', onWsMessage, {
        capture: false,
        passive: true,
      });
      console.log('[FoE-Info wsProxy] Captured game WebSocket');
    }

    return originalWsSend.call(this, data);
  };

  // ── Public API: check if WS is ready ─────────────────────────────────────
  window.__foeInfoWsReady = function () {
    return !!(gameSocket && gameSocket.readyState === WebSocket.OPEN);
  };

  console.log('[FoE-Info wsProxy] WebSocket proxy installed (passive mode)');
})();
