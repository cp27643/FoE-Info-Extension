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
 * Provides two capabilities:
 * 1. Passive interception — GBG messages pushed to __foeInfoWsMessages
 * 2. Active transport — __foeInfoSendWs() sends requests through the
 *    game's authenticated WebSocket using the next sequential requestId
 *
 * This file must remain plain vanilla JS — no imports, no webpack, no ES modules.
 */

(function () {
  'use strict';

  if (window.__foeInfoWsProxyInstalled) return;
  window.__foeInfoWsProxyInstalled = true;

  // ── Passive interception queues ──────────────────────────────────────────
  // GBG messages for the monitor
  window.__foeInfoWsMessages = [];
  // All WS responses for the scanner (keyed by requestId)
  window.__foeInfoWsResponses = {};

  // ── WebSocket capture state ──────────────────────────────────────────────
  var gameSocket = null; // The game's WebSocket instance
  var maxSeenRequestId = 0; // Highest requestId from the game's outgoing messages
  var observedSockets = new WeakSet();
  var originalSend = WebSocket.prototype.send;

  // ── Incoming message handler ─────────────────────────────────────────────
  function onWsMessage(evt) {
    try {
      if (evt.data === 'PONG' || evt.data === 'PING') return;

      var data = JSON.parse(evt.data);
      var messages = Array.isArray(data) ? data : [data];

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg || !msg.requestClass) continue;

        // Track requestIds from server responses to stay in sync
        if (typeof msg.requestId === 'number' && msg.requestId > maxSeenRequestId) {
          maxSeenRequestId = msg.requestId;
        }

        // GBG monitor: capture Battleground messages
        if (msg.requestClass.indexOf('Battleground') !== -1) {
          window.__foeInfoWsMessages.push(msg);
        }

        // Scanner transport: route responses by requestId
        if (typeof msg.requestId === 'number' && window.__foeInfoWsResponses[msg.requestId]) {
          window.__foeInfoWsResponses[msg.requestId].push(msg);
        }
      }
    } catch (e) {
      // Ignore non-JSON WebSocket messages
    }
  }

  // ── Outgoing message hook ────────────────────────────────────────────────
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

    // Track outgoing requestIds from the game client
    try {
      var parsed = JSON.parse(data);
      var outgoing = Array.isArray(parsed) ? parsed : [parsed];
      for (var j = 0; j < outgoing.length; j++) {
        if (typeof outgoing[j].requestId === 'number' && outgoing[j].requestId > maxSeenRequestId) {
          maxSeenRequestId = outgoing[j].requestId;
        }
      }
    } catch (e) {
      // Not JSON (e.g. PING) — ignore
    }

    return originalSend.call(this, data);
  };

  // ── Public API: send a request through the game's WebSocket ──────────────
  // Called from DevTools via chrome.devtools.inspectedWindow.eval()
  //
  // payload: array of ServerRequest objects (without requestId set)
  // Returns: { requestId: number } or { error: string }
  window.__foeInfoSendWs = function (payload) {
    if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) {
      return { error: 'No game WebSocket available' };
    }

    // Use the next sequential requestId after the highest we've seen
    var requestId = maxSeenRequestId + 1;
    maxSeenRequestId = requestId;

    // Stamp requestId on each request in the payload
    for (var k = 0; k < payload.length; k++) {
      payload[k].requestId = requestId;
    }

    // Prepare a response slot for this requestId
    window.__foeInfoWsResponses[requestId] = [];

    // Send through the game's authenticated WebSocket
    try {
      originalSend.call(gameSocket, JSON.stringify(payload));
      console.log('[FoE-Info wsProxy] Sent request via WS, requestId:', requestId);
      return { requestId: requestId };
    } catch (e) {
      delete window.__foeInfoWsResponses[requestId];
      return { error: 'WebSocket send failed: ' + e.message };
    }
  };

  // ── Public API: check if WS is ready ─────────────────────────────────────
  window.__foeInfoWsReady = function () {
    return !!(gameSocket && gameSocket.readyState === WebSocket.OPEN);
  };

  console.log('[FoE-Info wsProxy] WebSocket proxy installed');
})();
