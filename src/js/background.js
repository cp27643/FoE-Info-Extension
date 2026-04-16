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
 * Background service worker — minimal message relay.
 *
 * Relays GBG WebSocket messages from the wsBridge content script
 * to connected DevTools panel(s). Ports are keyed by tab ID so
 * messages from one tab only reach the DevTools panel inspecting
 * that tab.
 */

// Map<tabId, Set<Port>>
const devtoolsPorts = new Map();

// DevTools panels connect with name 'foe-info-gbg' and immediately
// send their inspected tabId.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'foe-info-gbg') return;

  let tabId = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'init' && typeof msg.tabId === 'number') {
      tabId = msg.tabId;
      if (!devtoolsPorts.has(tabId)) devtoolsPorts.set(tabId, new Set());
      devtoolsPorts.get(tabId).add(port);
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId !== null && devtoolsPorts.has(tabId)) {
      devtoolsPorts.get(tabId).delete(port);
      if (devtoolsPorts.get(tabId).size === 0) devtoolsPorts.delete(tabId);
    }
  });
});

// Content script (wsBridge.js) sends GBG messages here.
// Forward to the DevTools panel(s) inspecting the sender's tab.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'foe-info-ws-gbg') return;

  const tabId = sender.tab?.id;
  if (!tabId) return;

  const ports = devtoolsPorts.get(tabId);
  if (!ports || ports.size === 0) return;

  for (const port of ports) {
    try {
      port.postMessage({ type: 'foe-info-ws-gbg', payload: message.payload });
    } catch (e) {
      // Port may have disconnected
    }
  }
});
