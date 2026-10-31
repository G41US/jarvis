// Jarvis proxy - a Cloudflare Worker that holds YOUR Groq key, so people using the app never need one.
// The app sends its requests here; this forwards them to Groq with the key added, and nothing else.
//
// Settings (Cloudflare dashboard > your Worker > Settings > Variables and Secrets):
//   GROQ_API_KEY   (secret, required)  your Groq key
//   APP_TOKEN      (secret, recommended) any long random text; the same text goes into the app build (JARVIS_APP_TOKEN)
//   ALLOWED_MODELS (optional) comma-separated chat models allowed; default below
// Optional per-phone limit: add a Rate Limiting binding named LIMITER (see server/README.md).
// Updates: the build puts each new APK in the UPDATES store (KV) in 24 MB parts; the app asks /update for the newest build
// number and downloads /update/apk (the repo is private, so the app can't fetch it from GitHub itself).

const GROQ = 'https://api.groq.com/openai/v1';
const DEFAULT_MODELS = 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b';   // qwen: Jarvis's eyes (camera / screen), if it sees images
const MAX_AUDIO = 4 * 1024 * 1024, MAX_TOKENS = 4096;   // reasoning models count their thinking in this

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-jarvis-token, x-jarvis-device', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });
const fail = (status, message) => json({ error: { message } }, status);

// the newest build: {build, size, parts}. The app fetches the APK part by part (/update/apk?part=0, 1, ...): each part goes
// straight from storage to the phone, so nothing here can cut a long download short. /update/apk (all in one) is for
// builds 52-54, which ask for it that way.
async function update(route, url, env, ctx) {
  const meta = env.UPDATES ? await env.UPDATES.get('meta', 'json') : null;
  if (route === '/update') return json(meta ? { build: meta.build, size: meta.size, parts: meta.parts } : { build: 0 }, 200);
  if (!meta) return fail(404, 'No update stored yet.');
  const APK = { 'content-type': 'application/vnd.android.package-archive', 'cache-control': 'no-store', ...CORS };
  if (url.searchParams.has('part')) {
    const i = Number(url.searchParams.get('part'));
    const part = Number.isInteger(i) && i >= 0 && i < meta.parts ? await env.UPDATES.get(`apk:${meta.build}:${i}`, 'stream') : null;
    return part ? new Response(part, { status: 200, headers: APK }) : fail(404, 'No such part.');
  }
  // a fixed length tells the phone the size, so a cut-off download is caught (a plain stream loses its Content-Length)
  const { readable, writable } = typeof FixedLengthStream === 'function' ? new FixedLengthStream(meta.size) : new TransformStream();
  ctx.waitUntil((async () => {
    try {
      for (let i = 0; i < meta.parts; i++) {
        const part = await env.UPDATES.get(`apk:${meta.build}:${i}`, 'stream');
        if (!part) throw new Error('missing part ' + i);
        await part.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) { await writable.abort(e); }     // a cut-off download, which Android's installer rejects (never a broken install)
  })());
  return new Response(readable, { status: 200, headers: { 'content-type': 'application/vnd.android.package-archive', 'content-length': String(meta.size),
    'content-disposition': `attachment; filename="Jarvis-build-${meta.build}.apk"`, 'cache-control': 'no-store', ...CORS } });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.GROQ_API_KEY) return fail(500, 'The proxy has no GROQ_API_KEY set.');
    if (env.APP_TOKEN && req.headers.get('x-jarvis-token') !== env.APP_TOKEN) return fail(403, 'Unknown app.');

    const route = new URL(req.url).pathname.replace(/^\/v1(?=\/)/, '');
    if (route === '/update' || route === '/update/apk') return update(route, new URL(req.url), env, ctx);
    if (route === '/ping') return new Response(null, { status: 204, headers: CORS });   // the app warms its connection on "Hey Jarvis"
    const device = (req.headers.get('x-jarvis-device') || 'anonymous').slice(0, 64);
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: device });
      if (!success) return fail(429, 'Too many requests from this phone. Try again in a minute.');
    }

    const path = new URL(req.url).pathname.replace(/^\/v1(?=\/)/, '');
    const headers = { Authorization: `Bearer ${env.GROQ_API_KEY}` };
    let body;
    if (path === '/models' && req.method === 'GET') {
      // only used by the app's "Test connection"
    } else if (path === '/chat/completions' && req.method === 'POST') {
      let j;
      try { j = await req.json(); } catch { return fail(400, 'Bad JSON.'); }
      const allowed = String(env.ALLOWED_MODELS || DEFAULT_MODELS).split(',').map(s => s.trim()).filter(Boolean);
      if (!allowed.includes(j.model)) return fail(400, `Model not allowed: ${j.model}`);
      j.max_tokens = Math.min(Number(j.max_tokens) || 1024, MAX_TOKENS);
      delete j.n; delete j.user;
      body = JSON.stringify(j); headers['content-type'] = 'application/json';
    } else if (path === '/audio/transcriptions' && req.method === 'POST') {
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_AUDIO) return fail(413, 'Audio clip too long.');
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_AUDIO) return fail(413, 'Audio clip too long.');
      body = buf; headers['content-type'] = req.headers.get('content-type') || 'application/octet-stream';
    } else {
      return fail(404, 'Not found.');
    }

    const up = await fetch(GROQ + path, { method: req.method, headers, body });
    return new Response(up.body, { status: up.status, headers: { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', ...CORS } });
  },
};
