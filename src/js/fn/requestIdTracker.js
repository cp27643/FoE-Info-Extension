/*
 * requestIdTracker — Sends game API requests through the game's WebSocket.
 *
 * Uses the wsProxy.js content script which captures the game's authenticated
 * WebSocket connection and provides __foeInfoSendWs() to send requests with
 * auto-incremented sequential requestIds. Responses arrive through the same
 * WebSocket and are collected in __foeInfoWsResponses[requestId].
 *
 * This eliminates the need for MD5 signatures, version secret discovery, or
 * separate XHR requests — the game's own WebSocket handles authentication.
 */

// ── helpers ─────────────────────────────────────────────────────────────────

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

/** Returns true if the game's WebSocket is connected and ready. */
export async function isWsReady() {
  try {
    const ready = await evalInPage('window.__foeInfoWsReady && window.__foeInfoWsReady()');
    return !!ready;
  } catch {
    return false;
  }
}

// Keep legacy exports for backward compat (no longer needed but avoid import errors)
export function isSecretDiscovered() {
  return true;
}

export async function tryDiscoverSecret() {
  return true;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Sends a game API request through the game's WebSocket.
 *
 * @param {Array}  payloadTemplate  ServerRequest array (requestId will be set automatically).
 * @param {object} [opts]           Options (gameUrl, clientId, requestId are now ignored).
 *
 * @returns {{ requestId: number, response: any }}
 */
export async function sendJsonRequestAtomic(payloadTemplate, opts = {}) {
  // ── Send via the game's WebSocket ──
  const payload = JSON.parse(JSON.stringify(payloadTemplate));
  const payloadJson = JSON.stringify(payload);

  const sendResult = await evalInPage(
    `window.__foeInfoSendWs && window.__foeInfoSendWs(${payloadJson})`,
  );

  if (!sendResult) {
    throw new Error(
      '[requestIdTracker] wsProxy not loaded — is the extension installed and page refreshed?',
    );
  }

  if (sendResult.error) {
    throw new Error(`[requestIdTracker] ${sendResult.error}`);
  }

  const requestId = sendResult.requestId;
  console.log('[requestIdTracker] Sent via WebSocket, requestId:', requestId);

  // ── Poll for response on __foeInfoWsResponses[requestId] ──
  const POLL_INTERVAL = 100;
  const TIMEOUT = 15000;
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));

    const result = await evalInPage(
      `(function() {
        var r = window.__foeInfoWsResponses && window.__foeInfoWsResponses[${requestId}];
        if (r && r.length > 0) {
          delete window.__foeInfoWsResponses[${requestId}];
          return JSON.stringify({ requestId: ${requestId}, response: r });
        }
        return null;
      })()`,
    );

    if (result) {
      const parsed = JSON.parse(result);
      console.log('[requestIdTracker] Got WS response for requestId:', requestId);

      // Check for game server errors
      if (
        Array.isArray(parsed.response) &&
        parsed.response.some((r) => r?.__class__ === 'Error')
      ) {
        const errMsg = parsed.response.find((r) => r?.__class__ === 'Error');
        throw new Error(
          `[requestIdTracker] Game error: ${errMsg?.message ?? 'Unknown'}`,
        );
      }

      // Wrap response in the same format the old XHR approach returned
      // (array of ServerResponse objects)
      return { requestId: requestId, response: parsed.response };
    }
  }

  // Clean up the response slot on timeout
  await evalInPage(`delete window.__foeInfoWsResponses[${requestId}]`).catch(
    () => {},
  );
  throw new Error('[requestIdTracker] Request timed out after 15s');
}
