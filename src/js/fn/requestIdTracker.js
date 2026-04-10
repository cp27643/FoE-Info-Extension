/*
 * requestIdTracker — Tracks FoE game requestIds by intercepting outgoing XHRs.
 *
 * Installs a tiny monkey-patch on XMLHttpRequest in the inspected page that
 * captures the latest /game/json URL, client-identification header, and the
 * highest requestId from ALL outgoing request bodies.
 *
 * sendJsonRequestAtomic() claims the next requestId and fires the XHR in a
 * single inspectedWindow.eval() call so there is zero async gap for the game's
 * periodic timer to steal the same ID.
 */

// Wraps chrome.devtools.inspectedWindow.eval() as a Promise.
function evalInPage(script) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(script, (result, isException) => {
      if (isException) {
        reject(new Error(isException?.value ?? String(isException)));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Installs the XHR interceptor in the game page. Safe to call multiple times —
 * subsequent calls are no-ops if the interceptor is already present.
 */
export async function installTracker() {
  console.log('[requestIdTracker] installTracker() called');
  const script = `(function() {
    if (window.__foeInfoTracker) return 'already_installed';

    window.__foeInfoTracker = {
      lastGameUrl: '',
      lastClientId: '',
      maxRequestId: 0
    };

    var _origOpen = XMLHttpRequest.prototype.open;
    var _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    var _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__foeUrl = url;
      if (typeof url === 'string' && url.indexOf('/game/json?h=') !== -1) {
        window.__foeInfoTracker.lastGameUrl = url;
      }
      return _origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      if (this.__foeUrl && this.__foeUrl.indexOf('/game/json?h=') !== -1) {
        if (name === 'client-identification') {
          window.__foeInfoTracker.lastClientId = value;
        }
      }
      return _origSetHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      if (this.__foeUrl && this.__foeUrl.indexOf('/game/json?h=') !== -1 && body) {
        try {
          var parsed = JSON.parse(body);
          if (Array.isArray(parsed)) {
            for (var i = 0; i < parsed.length; i++) {
              if (parsed[i] && parsed[i].requestId > window.__foeInfoTracker.maxRequestId) {
                window.__foeInfoTracker.maxRequestId = parsed[i].requestId;
              }
            }
          }
        } catch(e) {}
      }
      return _origSend.apply(this, arguments);
    };

    return 'installed';
  })()`;

  const result = await evalInPage(script);
  console.log('[requestIdTracker] Interceptor:', result);
  return result;
}

/**
 * Claims the next requestId and sends a game API request atomically in the
 * page context. The payload should be a JSON-serializable array of
 * ServerRequest objects — requestId on the first element will be overwritten
 * with the claimed value.
 *
 * The requestId claim + XHR dispatch happen inside a single eval() so the
 * game's periodic timer cannot steal the same ID. Because
 * chrome.devtools.inspectedWindow.eval() cannot return Promises, the async
 * result (SHA-1 + XHR) is stored on window.__foeInfoTracker.pendingResults
 * and retrieved via polling.
 *
 * Returns { requestId: number, response: any }.
 * Throws on network error, invalid JSON, or tracker-not-ready.
 */
export async function sendJsonRequestAtomic(payloadTemplate) {
  const payloadJson = JSON.stringify(payloadTemplate);
  const callbackKey = `_foeReq_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  console.log('[requestIdTracker] sendJsonRequestAtomic called, callbackKey:', callbackKey);
  console.log('[requestIdTracker] payloadTemplate:', JSON.stringify(payloadTemplate, null, 2));

  const script = `(function() {
    var tracker = window.__foeInfoTracker;
    console.log('[requestIdTracker:page] tracker state:', JSON.stringify({
      exists: !!tracker,
      lastGameUrl: tracker ? tracker.lastGameUrl : null,
      lastClientId: tracker ? tracker.lastClientId : null,
      maxRequestId: tracker ? tracker.maxRequestId : null
    }));
    if (!tracker || !tracker.lastGameUrl) {
      console.warn('[requestIdTracker:page] BAIL — tracker not ready or no game URL');
      if (!tracker) window.__foeInfoTracker = { pendingResults: {} };
      if (!window.__foeInfoTracker.pendingResults) window.__foeInfoTracker.pendingResults = {};
      window.__foeInfoTracker.pendingResults['${callbackKey}'] =
        { __error__: 'Tracker not ready or no game URL captured' };
      return true;
    }
    if (!tracker.pendingResults) tracker.pendingResults = {};

    var payload = ${payloadJson};
    var nextId = tracker.maxRequestId + 1;
    tracker.maxRequestId = nextId;
    payload[0].requestId = nextId;

    var bodyStr = JSON.stringify(payload);
    var clientId = tracker.lastClientId ||
      'version=1.332; requiredVersion=1.332; platform=bro; platformType=html5; platformVersion=web';

    console.log('[requestIdTracker:page] Claiming requestId:', nextId);
    console.log('[requestIdTracker:page] POST URL:', tracker.lastGameUrl);
    console.log('[requestIdTracker:page] Body:', bodyStr.substring(0, 200));

    crypto.subtle.digest('SHA-1', new TextEncoder().encode(bodyStr))
      .then(function(hashBuffer) {
        var hex = Array.from(new Uint8Array(hashBuffer))
          .map(function(b) { return b.toString(16).padStart(2, '0'); })
          .join('');
        var signature = hex.substring(0, 10);
        console.log('[requestIdTracker:page] SHA-1 signature:', signature);
        console.log('[requestIdTracker:page] Sending XHR now...');

        var xhr = new XMLHttpRequest();
        xhr.open('POST', tracker.lastGameUrl, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('client-identification', clientId);
        xhr.setRequestHeader('signature', signature);
        xhr.onreadystatechange = function() {
          console.log('[requestIdTracker:page] XHR readyState:', xhr.readyState, 'status:', xhr.status);
          if (xhr.readyState !== 4) return;
          if (xhr.status >= 200 && xhr.status < 300) {
            console.log('[requestIdTracker:page] XHR SUCCESS, response length:', xhr.responseText.length);
            console.log('[requestIdTracker:page] Response preview:', xhr.responseText.substring(0, 300));
            try {
              tracker.pendingResults['${callbackKey}'] =
                { requestId: nextId, response: JSON.parse(xhr.responseText) };
            } catch(e) {
              console.error('[requestIdTracker:page] JSON parse failed:', e.message);
              tracker.pendingResults['${callbackKey}'] =
                { requestId: nextId, __fetchError__: 'Invalid JSON: ' + e.message };
            }
          } else {
            console.error('[requestIdTracker:page] XHR FAILED:', xhr.status, xhr.statusText);
            tracker.pendingResults['${callbackKey}'] =
              { requestId: nextId, __fetchError__: xhr.status + ' ' + xhr.statusText };
          }
        };
        xhr.onerror = function() {
          console.error('[requestIdTracker:page] XHR NETWORK ERROR');
          tracker.pendingResults['${callbackKey}'] =
            { requestId: nextId, __fetchError__: 'Network error' };
        };
        xhr.send(bodyStr);
      })
      .catch(function(err) {
        console.error('[requestIdTracker:page] SHA-1 or XHR setup failed:', err.message);
        tracker.pendingResults['${callbackKey}'] =
          { __error__: 'SHA-1 failed: ' + err.message };
      });

    return true;
  })()`;

  // Kick off the async XHR in the page context (eval returns synchronously)
  const evalResult = await evalInPage(script);
  console.log('[requestIdTracker] eval kickoff result:', evalResult);

  // Poll for the result stored by the page-context callback
  const POLL_INTERVAL = 100;
  const TIMEOUT = 15000;
  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < TIMEOUT) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
    pollCount++;

    const result = await evalInPage(
      `(function() {
        var t = window.__foeInfoTracker;
        var r = t && t.pendingResults && t.pendingResults['${callbackKey}'];
        if (r) { delete t.pendingResults['${callbackKey}']; }
        return r || null;
      })()`,
    );

    if (pollCount % 10 === 0) {
      console.log('[requestIdTracker] Still polling... attempt', pollCount, 'elapsed:', Date.now() - startTime, 'ms');
    }

    if (result) {
      console.log('[requestIdTracker] Got result after', pollCount, 'polls,', Date.now() - startTime, 'ms');
      console.log('[requestIdTracker] Result keys:', Object.keys(result));
      if (result.__error__) {
        console.error('[requestIdTracker] ERROR:', result.__error__);
        throw new Error(`[requestIdTracker] ${result.__error__}`);
      }
      if (result.__fetchError__) {
        console.error('[requestIdTracker] FETCH ERROR:', result.__fetchError__);
        throw new Error(`[requestIdTracker] HTTP error: ${result.__fetchError__}`);
      }
      console.log('[requestIdTracker] SUCCESS — requestId:', result.requestId, 'response is array:', Array.isArray(result.response));
      return result;
    }
  }

  console.error('[requestIdTracker] TIMEOUT after', pollCount, 'polls');
  throw new Error('[requestIdTracker] Request timed out after 15s');
}

/**
 * Reads the current tracker state from the page (useful for debugging).
 * Returns { lastGameUrl, lastClientId, maxRequestId } or null.
 */
export async function getTrackerState() {
  return evalInPage('window.__foeInfoTracker || null');
}
