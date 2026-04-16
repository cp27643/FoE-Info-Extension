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
 * WebSocket bridge — ISOLATED world content script.
 *
 * Listens for postMessage dispatched by wsProxy.js (MAIN world)
 * and forwards GBG messages to the extension via chrome.runtime.sendMessage.
 * The background service worker relays them to the DevTools panel.
 *
 * This file must remain plain vanilla JS — no imports, no webpack, no ES modules.
 */

(function () {
  'use strict';

  window.addEventListener('message', function (event) {
    // Only accept messages from our own page
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'foe-info-ws-gbg') return;

    try {
      var messages = JSON.parse(event.data.payload);
      chrome.runtime.sendMessage({
        type: 'foe-info-ws-gbg',
        payload: messages,
      });
    } catch (e) {
      // Ignore parse errors or disconnected runtime
    }
  });
})();
