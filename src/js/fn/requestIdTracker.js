/*
 * requestIdTracker — Sends game API requests from the inspected page context.
 *
 * sendJsonRequestAtomic() accepts the game URL, client-ID, and current
 * requestId counter from the caller (index.js already captures these via the
 * devtools network API). It evals a script in the page that claims the next
 * requestId, computes the SHA-1 signature, and fires the XHR — all in one
 * synchronous block so the game's periodic timer cannot steal the same ID.
 *
 * Because chrome.devtools.inspectedWindow.eval() cannot return Promises,
 * async results are stored on window.__foeInfoPending and retrieved by polling.
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
 * Claims the next requestId and sends a game API request atomically in the
 * page context.
 *
 * @param {Array} payloadTemplate - ServerRequest array; requestId on [0] will be overwritten.
 * @param {object} opts
 * @param {string} opts.gameUrl   - Full game JSON endpoint URL (with ?h= token).
 * @param {string} opts.clientId  - client-identification header value.
 * @param {number} opts.requestId - Highest requestId seen so far; next = this + 1.
 *
 * Returns { requestId: number, response: any }.
 */
export async function sendJsonRequestAtomic(payloadTemplate, { gameUrl, clientId, requestId: currentMaxId } = {}) {
  if (!gameUrl) {
    throw new Error('[requestIdTracker] No game URL provided — has the game loaded?');
  }

  const payloadJson = JSON.stringify(payloadTemplate);
  const callbackKey = `_foeReq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const nextId = (currentMaxId || 0) + 1;
  const safeGameUrl = gameUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const safeClientId = (clientId || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  console.log('[requestIdTracker] sendJsonRequestAtomic — callbackKey:', callbackKey);
  console.log('[requestIdTracker] gameUrl:', gameUrl.substring(0, 80) + '...');
  console.log('[requestIdTracker] nextRequestId:', nextId);

  const script = `(function() {
    if (!window.__foeInfoPending) window.__foeInfoPending = {};

    var payload = ${payloadJson};
    payload[0].requestId = ${nextId};

    var bodyStr = JSON.stringify(payload);
    var gameUrl = '${safeGameUrl}';
    var clientId = '${safeClientId}' ||
      'version=1.332; requiredVersion=1.332; platform=bro; platformType=html5; platformVersion=web';

    console.log('[requestIdTracker:page] Claiming requestId:', ${nextId});
    console.log('[requestIdTracker:page] POST URL:', gameUrl.substring(0, 80));
    console.log('[requestIdTracker:page] Body preview:', bodyStr.substring(0, 200));

    crypto.subtle.digest('SHA-1', new TextEncoder().encode(bodyStr))
      .then(function(hashBuffer) {
        var hex = Array.from(new Uint8Array(hashBuffer))
          .map(function(b) { return b.toString(16).padStart(2, '0'); })
          .join('');
        var signature = hex.substring(0, 10);
        console.log('[requestIdTracker:page] SHA-1 signature:', signature);
        console.log('[requestIdTracker:page] Sending XHR...');

        var xhr = new XMLHttpRequest();
        xhr.open('POST', gameUrl, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('client-identification', clientId);
        xhr.setRequestHeader('signature', signature);
        xhr.onreadystatechange = function() {
          console.log('[requestIdTracker:page] XHR readyState:', xhr.readyState, 'status:', xhr.status);
          if (xhr.readyState !== 4) return;
          if (xhr.status >= 200 && xhr.status < 300) {
            console.log('[requestIdTracker:page] XHR SUCCESS, length:', xhr.responseText.length);
            console.log('[requestIdTracker:page] Response preview:', xhr.responseText.substring(0, 300));
            try {
              window.__foeInfoPending['${callbackKey}'] =
                { requestId: ${nextId}, response: JSON.parse(xhr.responseText) };
            } catch(e) {
              console.error('[requestIdTracker:page] JSON parse failed:', e.message);
              window.__foeInfoPending['${callbackKey}'] =
                { requestId: ${nextId}, __fetchError__: 'Invalid JSON: ' + e.message };
            }
          } else {
            console.error('[requestIdTracker:page] XHR FAILED:', xhr.status, xhr.statusText);
            window.__foeInfoPending['${callbackKey}'] =
              { requestId: ${nextId}, __fetchError__: xhr.status + ' ' + xhr.statusText };
          }
        };
        xhr.onerror = function() {
          console.error('[requestIdTracker:page] XHR NETWORK ERROR');
          window.__foeInfoPending['${callbackKey}'] =
            { requestId: ${nextId}, __fetchError__: 'Network error' };
        };
        xhr.send(bodyStr);
      })
      .catch(function(err) {
        console.error('[requestIdTracker:page] SHA-1/XHR setup failed:', err.message);
        window.__foeInfoPending['${callbackKey}'] =
          { __error__: 'SHA-1 failed: ' + err.message };
      });

    return true;
  })()`;

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
        var r = window.__foeInfoPending && window.__foeInfoPending['${callbackKey}'];
        if (r) { delete window.__foeInfoPending['${callbackKey}']; }
        return r || null;
      })()`,
    );

    if (pollCount % 10 === 0) {
      console.log('[requestIdTracker] Still polling... attempt', pollCount, 'elapsed:', Date.now() - startTime, 'ms');
    }

    if (result) {
      console.log('[requestIdTracker] Got result after', pollCount, 'polls,', Date.now() - startTime, 'ms');
      if (result.__error__) {
        console.error('[requestIdTracker] ERROR:', result.__error__);
        throw new Error(`[requestIdTracker] ${result.__error__}`);
      }
      if (result.__fetchError__) {
        console.error('[requestIdTracker] FETCH ERROR:', result.__fetchError__);
        throw new Error(`[requestIdTracker] HTTP error: ${result.__fetchError__}`);
      }
      console.log('[requestIdTracker] SUCCESS — requestId:', result.requestId);
      return result;
    }
  }

  console.error('[requestIdTracker] TIMEOUT after', pollCount, 'polls');
  throw new Error('[requestIdTracker] Request timed out after 15s');
}
