// Jarvis proxy - a Cloudflare Worker that holds YOUR Groq key, so people using the app never need one.
// The app sends its requests here; this forwards them to Groq with the key added, and nothing else.
//
// Settings (Cloudflare dashboard > your Worker > Settings > Variables and Secrets):
//   GROQ_API_KEY   (secret, required)  your Groq key
//   APP_TOKEN      (secret, recommended) any long random text; the same text goes into the app build (JARVIS_APP_TOKEN)
//   ALLOWED_MODELS (optional) comma-separated chat models allowed; default below
// Optional per-phone limit: add a Rate Limiting binding named LIMITER (see server/README.md).

const GROQ = 'https://api.groq.com/openai/v1';
const DEFAULT_MODELS = 'openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile,llama-3.1-8b-instant';
const MAX_AUDIO = 4 * 1024 * 1024, MAX_TOKENS = 2000;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-jarvis-token, x-jarvis-device', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });
const fail = (status, message) => json({ error: { message } }, status);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.GROQ_API_KEY) return fail(500, 'The proxy has no GROQ_API_KEY set.');
    if (env.APP_TOKEN && req.headers.get('x-jarvis-token') !== env.APP_TOKEN) return fail(403, 'Unknown app.');

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
