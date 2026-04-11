/*
 * requestIdTracker — Sends game API requests from the inspected page context.
 *
 * sendJsonRequestAtomic() accepts the game URL, client-ID, and current
 * requestId from the caller. It builds the request body in the extension
 * context, computes the MD5-based signature, and evals a script in the page
 * that fires the XHR with correct credentials and signature.
 *
 * Signature algorithm (same as FoE's internal signing):
 *   signature = MD5(userKey + versionSecret + body).substring(0, 10)
 *
 * The versionSecret is a per-game-version static string embedded in the
 * ForgeHX compiled JavaScript. It is auto-discovered at runtime by searching
 * the Haxe class registry ($hxClasses) and cached for the session.
 *
 * Because chrome.devtools.inspectedWindow.eval() cannot return Promises,
 * async results are stored on window.__foeInfoPending and retrieved by polling.
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

function extractUserKey(gameUrl) {
  try {
    return new URL(gameUrl).searchParams.get('h') || '';
  } catch {
    const m = gameUrl.match(/[?&]h=([^&]+)/);
    return m ? m[1] : '';
  }
}

// ── MD5 (RFC 1321) ─────────────────────────────────────────────────────────
// Compact pure-JS implementation — runs in the extension context so the
// signature is computed before handing off to the page-level eval.

function md5(string) {
  function cmn(q, a, b, x, s, t) {
    a = (a + q + x + t) & 0xffffffff;
    return (((a << s) | (a >>> (32 - s))) + b) & 0xffffffff;
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }

  function md5cycle(x, k) {
    var a = x[0],
      b = x[1],
      c = x[2],
      d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = (a + x[0]) & 0xffffffff;
    x[1] = (b + x[1]) & 0xffffffff;
    x[2] = (c + x[2]) & 0xffffffff;
    x[3] = (d + x[3]) & 0xffffffff;
  }

  function md5blk(s) {
    var r = [];
    for (var i = 0; i < 64; i += 4)
      r[i >> 2] =
        s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24);
    return r;
  }

  function rhex(n) {
    var s = '',
      hex = '0123456789abcdef';
    for (var j = 0; j < 4; j++)
      s +=
        hex.charAt((n >> (j * 8 + 4)) & 0x0f) +
        hex.charAt((n >> (j * 8)) & 0x0f);
    return s;
  }

  var n = string.length,
    state = [1732584193, -271733879, -1732584194, 271733878],
    i;
  for (i = 64; i <= n; i += 64)
    md5cycle(state, md5blk(string.substring(i - 64, i)));
  string = string.substring(i - 64);
  var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < string.length; i++)
    tail[i >> 2] |= string.charCodeAt(i) << (i % 4 << 3);
  tail[i >> 2] |= 0x80 << (i % 4 << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return rhex(state[0]) + rhex(state[1]) + rhex(state[2]) + rhex(state[3]);
}

// ── Version secret discovery ────────────────────────────────────────────────
// The game signs every request with MD5(userKey + versionSecret + body).
// versionSecret is a per-build constant embedded in the ForgeHX JS.  We find
// it at runtime by searching the Haxe class registry or falling back to a
// source-text scan of the ForgeHX script.

let cachedSecret = null;
let discoveryInProgress = null; // Promise while discovery is running

async function discoverSecret() {
  if (cachedSecret) return cachedSecret;
  if (discoveryInProgress) return discoveryInProgress;

  discoveryInProgress = (async () => {
    console.log('[requestIdTracker] Discovering VERSION_SECRET…');

    // Strategy 1: search $hxClasses for base64 strings (fast, synchronous)
    const hxResult = await evalInPage(`(function() {
      if (!window.$hxClasses) return null;
      var re = /^[A-Za-z0-9+\\/]{80,}={0,2}$/;
      for (var n in window.$hxClasses) {
        var c = window.$hxClasses[n];
        if (!c) continue;
        for (var k in c) {
          try {
            if (typeof c[k] === 'string' && c[k].length >= 60 && re.test(c[k]))
              return JSON.stringify({ s: c[k], src: n + '.' + k });
          } catch(e) {}
        }
      }
      return null;
    })()`);

    if (hxResult) {
      const parsed = JSON.parse(hxResult);
      cachedSecret = parsed.s;
      console.log(
        '[requestIdTracker] Found secret via $hxClasses:',
        parsed.src,
        '(' + cachedSecret.length + ' chars)',
      );
      return cachedSecret;
    }

    // Strategy 2: fetch ForgeHX script source and regex-scan for base64 strings
    console.log(
      '[requestIdTracker] $hxClasses empty — scanning ForgeHX source…',
    );
    const fetchKey = `__foeSecretSearch_${Date.now()}`;
    await evalInPage(`(function() {
      var el = document.querySelector('script[src*="ForgeHX"]');
      if (!el) { window['${fetchKey}'] = { err: 'no ForgeHX script tag' }; return; }
      fetch(el.src).then(function(r){ return r.text(); }).then(function(text) {
        var m = text.match(/["'][A-Za-z0-9+\\/]{80,}={1,2}["']/g);
        window['${fetchKey}'] = m
          ? { c: m.map(function(x){ return x.slice(1,-1); }).filter(function(x){ return x.length >= 80 && x.length <= 100; }) }
          : { err: 'no base64 matches' };
      }).catch(function(e){ window['${fetchKey}'] = { err: e.message }; });
    })()`);

    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const raw = await evalInPage(`(function() {
        var r = window['${fetchKey}'];
        if (r) { delete window['${fetchKey}']; return JSON.stringify(r); }
        return null;
      })()`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.c && parsed.c.length > 0) {
          cachedSecret = parsed.c[0];
          console.log(
            '[requestIdTracker] Found secret via ForgeHX source scan,',
            parsed.c.length,
            'candidates — using first (' + cachedSecret.length + ' chars)',
          );
          return cachedSecret;
        }
        console.warn('[requestIdTracker] ForgeHX scan failed:', parsed.err);
        break;
      }
    }

    // Strategy 3: intercept the next game request's signature header so we can
    // at least log the expected value for manual debugging.
    console.warn(
      '[requestIdTracker] Could not auto-discover secret — requests will be unsigned',
    );
    return null;
  })();

  try {
    return await discoveryInProgress;
  } finally {
    discoveryInProgress = null;
  }
}

// ── Signature computation ───────────────────────────────────────────────────

function computeSignature(userKey, secret, body) {
  return md5(userKey + secret + body).substring(0, 10);
}

/** Returns true if the VERSION_SECRET has already been discovered and cached. */
export function isSecretDiscovered() {
  return cachedSecret != null;
}

/** Kicks off secret discovery (no-op if already cached). Returns a Promise<boolean>. */
export async function tryDiscoverSecret() {
  const s = await discoverSecret();
  return s != null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Sends a game API request from the page context with proper signing.
 *
 * @param {Array}  payloadTemplate  ServerRequest array (requestId will be set).
 * @param {object} opts
 * @param {string} opts.gameUrl     Full game JSON endpoint (with ?h= token).
 * @param {string} opts.clientId    client-identification header value.
 * @param {number} opts.requestId   The requestId to stamp on the request.
 *
 * @returns {{ requestId: number, response: any }}
 */
export async function sendJsonRequestAtomic(
  payloadTemplate,
  { gameUrl, clientId, requestId } = {},
) {
  if (!gameUrl) {
    throw new Error(
      '[requestIdTracker] No game URL provided — has the game loaded?',
    );
  }

  // ── discover secret (one-time, cached) ──
  const secret = await discoverSecret();
  const userKey = extractUserKey(gameUrl);

  // ── build body & signature in the extension context ──
  const payload = JSON.parse(JSON.stringify(payloadTemplate));
  payload[0].requestId = requestId;
  const bodyStr = JSON.stringify(payload);

  let signature = '';
  if (secret && userKey) {
    signature = computeSignature(userKey, secret, bodyStr);
    console.log(
      '[requestIdTracker] requestId:',
      requestId,
      'signature:',
      signature,
    );
  } else {
    console.warn(
      '[requestIdTracker] Missing secret or userKey — unsigned request!',
    );
  }

  // ── fire XHR in the page context ──
  const callbackKey = `_foeReq_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Use JSON.stringify to safely embed strings in the eval script
  const script = `(function() {
    if (!window.__foeInfoPending) window.__foeInfoPending = {};

    var bodyStr  = ${JSON.stringify(bodyStr)};
    var gameUrl  = ${JSON.stringify(gameUrl)};
    var clientId = ${JSON.stringify(clientId || '')};
    var sig      = ${JSON.stringify(signature)};

    if (!clientId) clientId = 'version=1.332; requiredVersion=1.332; platform=bro; platformType=html5; platformVersion=web';

    console.log('[requestIdTracker:page] Sending requestId:', ${requestId}, 'sig:', sig);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', gameUrl, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('client-identification', clientId);
    if (sig) xhr.setRequestHeader('signature', sig);
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      console.log('[requestIdTracker:page] XHR done — status:', xhr.status, 'len:', (xhr.responseText||'').length);
      if (xhr.status >= 200 && xhr.status < 300) {
        console.log('[requestIdTracker:page] Preview:', xhr.responseText.substring(0, 300));
        try {
          window.__foeInfoPending['${callbackKey}'] =
            { requestId: ${requestId}, response: JSON.parse(xhr.responseText) };
        } catch(e) {
          window.__foeInfoPending['${callbackKey}'] =
            { requestId: ${requestId}, __fetchError__: 'Bad JSON: ' + e.message };
        }
      } else {
        window.__foeInfoPending['${callbackKey}'] =
          { requestId: ${requestId}, __fetchError__: xhr.status + ' ' + xhr.statusText };
      }
    };
    xhr.onerror = function() {
      window.__foeInfoPending['${callbackKey}'] =
        { requestId: ${requestId}, __fetchError__: 'Network error' };
    };
    xhr.send(bodyStr);
    return true;
  })()`;

  await evalInPage(script);

  // ── poll for the async result ──
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
      console.log(
        '[requestIdTracker] Polling…',
        pollCount,
        'elapsed:',
        Date.now() - startTime,
        'ms',
      );
    }

    if (result) {
      console.log(
        '[requestIdTracker] Got result after',
        pollCount,
        'polls,',
        Date.now() - startTime,
        'ms',
      );
      if (result.__fetchError__) {
        throw new Error(
          `[requestIdTracker] HTTP error: ${result.__fetchError__}`,
        );
      }
      console.log('[requestIdTracker] SUCCESS — requestId:', result.requestId);
      return result;
    }
  }

  throw new Error('[requestIdTracker] Request timed out after 15s');
}

/**
 * Sends a batch of game API requests in a single XHR from the page context.
 *
 * @param {Array}  payloads   Array of ServerRequest objects (requestId will be set on all).
 * @param {object} opts
 * @param {string} opts.gameUrl     Full game JSON endpoint (with ?h= token).
 * @param {string} opts.clientId    client-identification header value.
 * @param {number} opts.requestId   The requestId to stamp on every request in the batch.
 * @param {number} [opts.timeout=30000]  Timeout in ms (default 30s for large batches).
 *
 * @returns {{ requestId: number, response: Array }}
 */
export async function sendBatchRequestAtomic(
  payloads,
  { gameUrl, clientId, requestId, timeout = 30000 } = {},
) {
  if (!gameUrl) {
    throw new Error(
      '[requestIdTracker] No game URL provided — has the game loaded?',
    );
  }

  const secret = await discoverSecret();
  const userKey = extractUserKey(gameUrl);

  // Stamp requestId on every item in the batch
  const batch = payloads.map((p) => ({
    ...JSON.parse(JSON.stringify(p)),
    requestId,
  }));
  const bodyStr = JSON.stringify(batch);

  let signature = '';
  if (secret && userKey) {
    signature = computeSignature(userKey, secret, bodyStr);
    console.log(
      '[requestIdTracker] Batch requestId:',
      requestId,
      'items:',
      batch.length,
      'signature:',
      signature,
    );
  } else {
    console.warn(
      '[requestIdTracker] Missing secret or userKey — unsigned batch!',
    );
  }

  const callbackKey = `_foeBatch_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const script = `(function() {
    if (!window.__foeInfoPending) window.__foeInfoPending = {};

    var bodyStr  = ${JSON.stringify(bodyStr)};
    var gameUrl  = ${JSON.stringify(gameUrl)};
    var clientId = ${JSON.stringify(clientId || '')};
    var sig      = ${JSON.stringify(signature)};

    if (!clientId) clientId = 'version=1.332; requiredVersion=1.332; platform=bro; platformType=html5; platformVersion=web';

    console.log('[requestIdTracker:page] Sending batch requestId:', ${requestId}, 'items:', ${batch.length}, 'sig:', sig);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', gameUrl, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('client-identification', clientId);
    if (sig) xhr.setRequestHeader('signature', sig);
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      console.log('[requestIdTracker:page] Batch XHR done — status:', xhr.status, 'len:', (xhr.responseText||'').length);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          window.__foeInfoPending['${callbackKey}'] =
            { requestId: ${requestId}, response: JSON.parse(xhr.responseText) };
        } catch(e) {
          window.__foeInfoPending['${callbackKey}'] =
            { requestId: ${requestId}, __fetchError__: 'Bad JSON: ' + e.message };
        }
      } else {
        window.__foeInfoPending['${callbackKey}'] =
          { requestId: ${requestId}, __fetchError__: xhr.status + ' ' + xhr.statusText };
      }
    };
    xhr.onerror = function() {
      window.__foeInfoPending['${callbackKey}'] =
        { requestId: ${requestId}, __fetchError__: 'Network error' };
    };
    xhr.send(bodyStr);
    return true;
  })()`;

  await evalInPage(script);

  // Poll for the async result with configurable timeout
  const POLL_INTERVAL = 150;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));

    const result = await evalInPage(
      `(function() {
        var r = window.__foeInfoPending && window.__foeInfoPending['${callbackKey}'];
        if (r) { delete window.__foeInfoPending['${callbackKey}']; }
        return r || null;
      })()`,
    );

    if (result) {
      console.log(
        '[requestIdTracker] Batch result after',
        Date.now() - startTime,
        'ms',
      );
      if (result.__fetchError__) {
        throw new Error(
          `[requestIdTracker] Batch HTTP error: ${result.__fetchError__}`,
        );
      }
      return result;
    }
  }

  throw new Error(
    `[requestIdTracker] Batch request timed out after ${timeout / 1000}s`,
  );
}

/**
 * Fires many batch XHRs in parallel using a SINGLE eval to inject all of them,
 * then polls for all results in a single eval per tick.  This avoids the
 * thundering-herd problem that occurs when each batch polls independently.
 *
 * @param {Array<{ payloads: Array, requestId: number }>} batchGroups
 * @param {object} opts
 * @param {string} opts.gameUrl
 * @param {string} opts.clientId
 * @param {number} [opts.timeout=30000]
 * @returns {Array<{ requestId: number, response?: Array, __fetchError__?: string }>}
 */
export async function sendParallelBatchesAtomic(
  batchGroups,
  { gameUrl, clientId, timeout = 30000 } = {},
) {
  if (!gameUrl) {
    throw new Error(
      '[requestIdTracker] No game URL provided — has the game loaded?',
    );
  }

  const secret = await discoverSecret();
  const userKey = extractUserKey(gameUrl);

  // Prepare every batch: stamp requestId, compute signature, assign callback key
  const infos = batchGroups.map(({ payloads, requestId }) => {
    const batch = payloads.map((p) => ({
      ...JSON.parse(JSON.stringify(p)),
      requestId,
    }));
    const bodyStr = JSON.stringify(batch);
    const signature =
      secret && userKey ? computeSignature(userKey, secret, bodyStr) : '';
    const callbackKey = `_foePar_${requestId}_${Math.random().toString(36).slice(2)}`;
    return { bodyStr, signature, requestId, callbackKey };
  });

  // ── Fire ALL XHRs in one eval ──────────────────────────────────────────
  const batchData = infos.map((b) => ({
    body: b.bodyStr,
    sig: b.signature,
    key: b.callbackKey,
    rid: b.requestId,
  }));

  const fireScript = `(function() {
    if (!window.__foeInfoPending) window.__foeInfoPending = {};
    var url  = ${JSON.stringify(gameUrl)};
    var cid  = ${JSON.stringify(clientId || '')}
      || 'version=1.332; requiredVersion=1.332; platform=bro; platformType=html5; platformVersion=web';
    var list = ${JSON.stringify(batchData)};

    list.forEach(function(b) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('client-identification', cid);
      if (b.sig) xhr.setRequestHeader('signature', b.sig);
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            window.__foeInfoPending[b.key] =
              { requestId: b.rid, response: JSON.parse(xhr.responseText) };
          } catch(e) {
            window.__foeInfoPending[b.key] =
              { requestId: b.rid, __fetchError__: 'Bad JSON: ' + e.message };
          }
        } else {
          window.__foeInfoPending[b.key] =
            { requestId: b.rid, __fetchError__: xhr.status + ' ' + xhr.statusText };
        }
      };
      xhr.onerror = function() {
        window.__foeInfoPending[b.key] =
          { requestId: b.rid, __fetchError__: 'Network error' };
      };
      xhr.send(b.body);
    });
    return list.length;
  })()`;

  const fired = await evalInPage(fireScript);
  console.log('[requestIdTracker] Fired', fired, 'parallel batch XHRs');

  // ── Poll for ALL results in one eval per tick ──────────────────────────
  const allKeys = infos.map((b) => b.callbackKey);
  const collected = {};
  const POLL_INTERVAL = 200;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));

    const remaining = allKeys.filter((k) => !collected[k]);
    if (remaining.length === 0) break;

    const pollScript = `(function() {
      var keys = ${JSON.stringify(remaining)};
      var out = {};
      keys.forEach(function(k) {
        var r = window.__foeInfoPending && window.__foeInfoPending[k];
        if (r) { delete window.__foeInfoPending[k]; out[k] = r; }
      });
      return out;
    })()`;

    const batch = await evalInPage(pollScript);
    if (batch) Object.assign(collected, batch);

    if (allKeys.every((k) => collected[k])) break;
  }

  console.log(
    '[requestIdTracker] Parallel batches done in',
    Date.now() - startTime,
    'ms —',
    Object.keys(collected).length,
    '/',
    allKeys.length,
    'received',
  );

  return infos.map((b) => {
    const r = collected[b.callbackKey];
    if (!r) return { requestId: b.requestId, __fetchError__: 'Timeout' };
    return r;
  });
}
