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

  // ── Shared state ──────────────────────────────────────────────────────────
  var observedSockets = new WeakSet();
  var originalWsSend = WebSocket.prototype.send;

  // ── Incoming WS message handler ─────────────────────────────────────────
  function onWsMessage(evt) {
    try {
      if (evt.data === 'PONG' || evt.data === 'PING') return;

      var data = JSON.parse(evt.data);
      var messages = Array.isArray(data) ? data : [data];

      var gbgBatch = [];
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg || !msg.requestClass) continue;

        // GBG monitor: capture Battleground messages
        if (msg.requestClass.indexOf('Battleground') !== -1) {
          gbgBatch.push(msg);
        }
      }

      // Push batch to extension via postMessage (picked up by wsBridge.js)
      if (gbgBatch.length > 0) {
        window.postMessage(
          {
            type: 'foe-info-ws-gbg',
            payload: JSON.stringify(gbgBatch),
          },
          window.location.origin,
        );
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
      this.addEventListener('message', onWsMessage, {
        capture: false,
        passive: true,
      });
      console.log('[FoE-Info wsProxy] Captured game WebSocket');
    }

    return originalWsSend.call(this, data);
  };

  console.log('[FoE-Info wsProxy] WebSocket proxy installed (passive mode)');
})();
