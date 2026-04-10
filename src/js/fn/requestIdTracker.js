/*
 * ________________________________________________________________
 * Copyright (C) 2022 FoE-Info - All Rights Reserved
 * this source-code uses a copy-left license
 *
 * you are welcome to contribute changes here:
 * https://github.com/FoE-Info/FoE-Info-Extension
 *
 * AGPL license info:
 * https://github.com/FoE-Info/FoE-Info-Extension/master/LICENSE.md
 * or else visit https://www.gnu.org/licenses/#AGPL
 * ________________________________________________________________
 */

const REQUEST_TRACKER_KEY = '__foeInfoRequestTracker';

function evalInInspectedWindow(expression) {
  return new Promise((resolve, reject) => {
    if (!chrome?.devtools?.inspectedWindow?.eval) {
      reject(new Error('DevTools inspectedWindow.eval is unavailable.'));
      return;
    }

    chrome.devtools.inspectedWindow.eval(
      expression,
      (result, exceptionInfo) => {
        if (exceptionInfo && exceptionInfo.isException) {
          reject(
            new Error(exceptionInfo.value || 'Unable to evaluate script.'),
          );
          return;
        }
        resolve(result);
      },
    );
  });
}

function buildEnsureTrackerExpression() {
  return `(() => {
    const trackerKey = ${JSON.stringify(REQUEST_TRACKER_KEY)};
    if (window[trackerKey] && window[trackerKey].installed) {
      return {
        installed: true,
        alreadyInstalled: true,
        lastRequestId: window[trackerKey].lastRequestId,
        lastJsonUrl: window[trackerKey].lastJsonUrl,
        lastSignature: window[trackerKey].lastSignature
      };
    }

    const tracker = window[trackerKey] || {
      installed: false,
      lastRequestId: null,
      lastJsonUrl: '',
      lastSignature: ''
    };

    const updateFromPayload = (payload) => {
      if (!Array.isArray(payload)) {
        return;
      }

      payload.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }

        const requestId = Number(entry.requestId);
        if (Number.isFinite(requestId)) {
          tracker.lastRequestId = requestId;
        }
      });
    };

    const updateFromUrl = (requestUrl) => {
      if (typeof requestUrl !== 'string') {
        return;
      }

      if (!/\/game\/json\?h=/.test(requestUrl)) {
        return;
      }

      tracker.lastJsonUrl = requestUrl;
      const signature = requestUrl.split('h=')[1] || '';
      tracker.lastSignature = signature.split('&')[0];
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (...args) {
      this.__foeInfoTrackedUrl = args[1];
      updateFromUrl(this.__foeInfoTrackedUrl);
      return originalOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function (body) {
      updateFromUrl(this.__foeInfoTrackedUrl);

      if (typeof body === 'string' && body.length > 2) {
        try {
          updateFromPayload(JSON.parse(body));
        } catch (_error) {
          // ignore malformed or non-json request bodies
        }
      }

      return originalSend.apply(this, arguments);
    };

    tracker.installed = true;
    window[trackerKey] = tracker;

    return {
      installed: true,
      alreadyInstalled: false,
      lastRequestId: tracker.lastRequestId,
      lastJsonUrl: tracker.lastJsonUrl,
      lastSignature: tracker.lastSignature
    };
  })();`;
}

export async function ensureRequestTrackerInstalled() {
  return evalInInspectedWindow(buildEnsureTrackerExpression());
}

export async function sendJsonRequestAtomic(payload) {
  const normalizedPayload = Array.isArray(payload) ? payload : [payload];
  const payloadJson = JSON.stringify(normalizedPayload);

  const expression = `(() => {
    const trackerKey = ${JSON.stringify(REQUEST_TRACKER_KEY)};
    const payload = ${payloadJson};

    const ensureTracker = ${buildEnsureTrackerExpression()};

    const tracker = window[trackerKey];
    if (!tracker || !tracker.installed) {
      return { ok: false, error: 'Request tracker could not be installed.' };
    }

    const currentRequestId = Number(tracker.lastRequestId);
    const nextRequestId = Number.isFinite(currentRequestId) ? currentRequestId + 1 : 1;

    payload.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      entry.requestId = nextRequestId + index;
    });

    tracker.lastRequestId = nextRequestId + payload.length - 1;

    const requestUrl = tracker.lastJsonUrl || (tracker.lastSignature ? window.location.origin + '/game/json?h=' + tracker.lastSignature : '');
    if (!requestUrl) {
      return {
        ok: false,
        error: 'Missing FoE JSON URL/signature. Wait for one normal game request first.'
      };
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', requestUrl, false);
    xhr.setRequestHeader('content-type', 'application/json');

    let responseBody = '';
    let responseJson = null;

    try {
      xhr.send(JSON.stringify(payload));
      responseBody = xhr.responseText || '';
      if (responseBody) {
        responseJson = JSON.parse(responseBody);
      }
    } catch (error) {
      return {
        ok: false,
        requestIds: payload.map((entry) => entry?.requestId),
        status: xhr.status,
        error: String(error && error.message ? error.message : error)
      };
    }

    return {
      ok: xhr.status >= 200 && xhr.status < 400,
      requestIds: payload.map((entry) => entry?.requestId),
      status: xhr.status,
      response: responseJson,
      trackerState: {
        lastRequestId: tracker.lastRequestId,
        lastJsonUrl: tracker.lastJsonUrl,
        lastSignature: tracker.lastSignature
      }
    };
  })();`;

  return evalInInspectedWindow(expression);
}
