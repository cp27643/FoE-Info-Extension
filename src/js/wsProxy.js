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
 * Incoming messages whose requestClass relates to GBG (Guild Battleground)
 * are pushed to window.__foeInfoWsMessages for the DevTools panel to drain.
 *
 * This file must remain plain vanilla JS — no imports, no webpack, no ES modules.
 */

(function () {
  'use strict';

  if (window.__foeInfoWsProxyInstalled) return;
  window.__foeInfoWsProxyInstalled = true;

  // Queue that the DevTools panel drains via eval
  window.__foeInfoWsMessages = [];

  var observedSockets = new WeakSet();
  var originalSend = WebSocket.prototype.send;

  function onWsMessage(evt) {
    try {
      if (evt.data === 'PONG' || evt.data === 'PING') return;

      var data = JSON.parse(evt.data);
      var messages = Array.isArray(data) ? data : [data];

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg || !msg.requestClass) continue;

        // Capture all Battleground-related messages
        if (msg.requestClass.indexOf('Battleground') !== -1) {
          window.__foeInfoWsMessages.push(msg);
        }
      }
    } catch (e) {
      // Ignore non-JSON WebSocket messages
    }
  }

  WebSocket.prototype.send = function (data) {
    // Hook the message listener the first time this socket sends
    if (!observedSockets.has(this)) {
      observedSockets.add(this);
      this.addEventListener('message', onWsMessage, {
        capture: false,
        passive: true,
      });
      console.log('[FoE-Info wsProxy] Hooked WebSocket message listener');
    }
    return originalSend.call(this, data);
  };

  console.log('[FoE-Info wsProxy] WebSocket proxy installed');
})();
