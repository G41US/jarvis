// net.js - network + storage helpers for the on-phone Jarvis.
// Native-first HTTP: the Android shell does the request (no CORS, real User-Agent, which Nominatim requires).
// In a plain browser (tests, desktop preview) it falls back to fetch().
const G = globalThis;
export const realFetch = G.fetch ? G.fetch.bind(G) : null;      // captured before shim.js replaces fetch for local endpoints

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const pending = new Map();
let nextId = 1;
if (G.window) {
  G.window.__httpResult = (id, status, body) => {
    const p = pending.get(id);
    if (p) { pending.delete(id); p.resolve({ status, text: body }); }
  };
}
export const nativeHttp = () => !!(G.window && G.window.AndroidBridge && G.window.AndroidBridge.httpRequest);

export function buildUrl(url, params) {
  if (!params) return url;
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return q ? url + (url.includes('?') ? '&' : '?') + q : url;
}

/** One request. Resolves {status, text}; never rejects (status 0 on network failure). */
export async function httpRaw(url, { method = 'GET', headers = {}, body = null, timeoutMs = 12000 } = {}) {
  if (nativeHttp()) {
    const id = nextId++;
    return new Promise(resolve => {
      const t = setTimeout(() => { pending.delete(id); resolve({ status: 0, text: '', error: 'timeout' }); }, timeoutMs + 3000);
      pending.set(id, { resolve: r => { clearTimeout(t); resolve(r); } });
      try { G.window.AndroidBridge.httpRequest(id, method, url, JSON.stringify(headers), body == null ? '' : String(body), timeoutMs); }
      catch (e) { clearTimeout(t); pending.delete(id); resolve({ status: 0, text: '', error: String(e) }); }
    });
  }
  if (!realFetch) return { status: 0, text: '', error: 'no fetch' };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const hdr = { ...headers }; delete hdr['User-Agent'];            // browsers refuse to set it
    const r = await realFetch(url, { method, headers: hdr, body: body == null ? undefined : body, signal: ctl.signal });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: '', error: String(e && e.message || e) }; }
  finally { clearTimeout(t); }
}

/** (url, params, body) -> parsed JSON or null. GET with params, POST JSON when body is given. */
export function makeHttp({ userAgent = 'Jarvis/1.0', language = 'en', timeoutMs = 12000, log = () => {} } = {}) {
  return async function http(url, params = null, body = null) {
    const headers = { 'User-Agent': userAgent, 'Accept-Language': language, 'Accept': 'application/json' };
    let r;
    if (body != null) { headers['Content-Type'] = 'application/json'; r = await httpRaw(buildUrl(url, null), { method: 'POST', headers, body: JSON.stringify(body), timeoutMs }); }
    else r = await httpRaw(buildUrl(url, params), { headers, timeoutMs });
    if (!r.status) { log(`http fail ${url.split('?')[0]}: ${r.error || 'network'}`); return null; }
    try { return JSON.parse(r.text); } catch { return null; }
  };
}

/** Shared politeness limiter: Nominatim allows one request per second across the whole app. */
export function makeThrottle(minMs) {
  let last = 0, chain = Promise.resolve();
  return function throttle() {
    chain = chain.then(async () => {
      const wait = minMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    return chain;
  };
}
export const nominatimThrottle = makeThrottle(1100);

// ------------------------------------------------------------------- storage
export function makeKV(backend) {
  let mem = {};
  const ls = (() => { try { const s = backend || G.localStorage; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch { return null; } })();
  return {
    get(k, d = null) { try { const v = ls ? ls.getItem('jv:' + k) : mem['jv:' + k]; return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { const s = JSON.stringify(v); if (ls) ls.setItem('jv:' + k, s); else mem['jv:' + k] = s; } catch (e) {} },
    del(k) { try { if (ls) ls.removeItem('jv:' + k); else delete mem['jv:' + k]; } catch (e) {} },
  };
}
export const kv = makeKV();

// ------------------------------------------------------------------- python-compatible rounding
/** Python's round(): halves go to the even number. */
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5 - 1e-12) return f;
  if (d > 0.5 + 1e-12) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
export const round1 = x => Math.round(x * 10) / 10;
export const round2 = x => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- streaming fetch through the Android shell
// Groq (and the optional Jarvis proxy) are called from Java, so the browser's cross-origin rules never apply.
// Returns a real Response whose body streams as Java reads it (SSE works).
const streams = new Map();
let nextStreamId = 1;
if (G.window) {
  G.window.__httpHead = (id, status) => { const s = streams.get(id); if (s && !s.headed) { s.headed = true; s.status = status; s.resolveHead(status); } };
  G.window.__httpChunk = (id, b64) => { const s = streams.get(id); if (s && s.ctl) { try { s.ctl.enqueue(b64ToBytes(b64)); } catch {} } };
  G.window.__httpEnd = (id, error) => {
    const s = streams.get(id); if (!s) return; streams.delete(id);
    if (!s.headed) { s.headed = true; s.rejectHead(new TypeError(error || 'Network request failed')); }
    try { if (error && s.ctl) s.ctl.error(new TypeError(error)); else if (s.ctl) s.ctl.close(); } catch {}
  };
}
export const nativeStream = () => !!(G.window && G.window.AndroidBridge && G.window.AndroidBridge.httpStream);
export function bytesToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
export function b64ToBytes(b64) { const s = atob(b64 || ''); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

async function bodyBytes(body, headers) {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof FormData !== 'undefined' && body instanceof FormData) {        // multipart by hand (Whisper uploads)
    const boundary = '----jarvis' + Math.random().toString(16).slice(2), enc = new TextEncoder(), parts = [];
    for (const [name, val] of body.entries()) {
      if (typeof val === 'string') parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
      else {
        parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${val.name || 'file'}"\r\nContent-Type: ${val.type || 'application/octet-stream'}\r\n\r\n`));
        parts.push(new Uint8Array(await val.arrayBuffer())); parts.push(enc.encode('\r\n'));
      }
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new TextEncoder().encode(String(body));
}

export async function nativeFetch(url, init = {}) {
  const headers = {}; const h = init.headers || {};
  if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { headers[k] = v; }); else Object.assign(headers, h);
  const bytes = await bodyBytes(init.body, headers);
  if (init.signal && init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const id = nextStreamId++, s = { headed: false };
  const head = new Promise((res, rej) => { s.resolveHead = res; s.rejectHead = rej; });
  const body = new ReadableStream({ start(c) { s.ctl = c; }, cancel() { try { G.window.AndroidBridge.httpAbort(id); } catch {} streams.delete(id); } });
  streams.set(id, s);
  if (init.signal) init.signal.addEventListener('abort', () => {
    try { G.window.AndroidBridge.httpAbort(id); } catch {}
    const err = new DOMException('Aborted', 'AbortError'); streams.delete(id);
    if (!s.headed) { s.headed = true; s.rejectHead(err); } try { s.ctl.error(err); } catch {}
  });
  G.window.AndroidBridge.httpStream(id, (init.method || 'GET').toUpperCase(), url, JSON.stringify(headers), bytes ? bytesToB64(bytes) : '', Number(init.timeoutMs) || 60000);
  const status = await head;
  return new Response(body, { status: status === 204 ? 200 : status, statusText: String(status) });
}

/** fetch() for the AI services: through Android when available, plain fetch in a browser. */
export const apiFetch = (url, init) => (nativeStream() ? nativeFetch(url, init) : realFetch(url, init));
