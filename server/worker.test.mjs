// node server/worker.test.mjs - checks the proxy with a fake Groq behind it
import worker from './worker.js';
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + x)); if (!c) fails++; };
const seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url, init });
  if (url.endsWith('/chat/completions')) return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  if (url.endsWith('/audio/transcriptions')) return new Response('{"text":"hello"}', { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const env = { GROQ_API_KEY: 'gsk_secret', APP_TOKEN: 'tok' };
const H = { 'x-jarvis-token': 'tok', 'x-jarvis-device': 'phone1' };
const call = (path, init = {}, e = env) => worker.fetch(new Request('https://jarvis.example.workers.dev' + path, init), e);

let r = await call('/v1/models', { headers: H });
check('models ok', r.status === 200 && seen.at(-1).init.headers.Authorization === 'Bearer gsk_secret');
r = await call('/v1/models', { headers: { 'x-jarvis-token': 'wrong' } });
check('wrong app token refused', r.status === 403);
r = await call('/v1/chat/completions', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-oss-120b', stream: true, max_tokens: 99999, messages: [] }) });
const txt = await r.text();
check('chat streams through', r.status === 200 && txt.includes('[DONE]') && r.headers.get('content-type') === 'text/event-stream');
check('max_tokens capped', JSON.parse(seen.at(-1).init.body).max_tokens === 2000);
check('key added, app token not forwarded', seen.at(-1).init.headers.Authorization === 'Bearer gsk_secret' && !('x-jarvis-token' in seen.at(-1).init.headers));
r = await call('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'some-expensive-model', messages: [] }) });
check('unknown model refused', r.status === 400);
const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(1000)], { type: 'audio/wav' }), 'a.wav'); fd.append('model', 'whisper-large-v3-turbo');
r = await call('/v1/audio/transcriptions', { method: 'POST', headers: H, body: fd });
check('transcription forwarded', r.status === 200 && (await r.json()).text === 'hello' && /multipart\/form-data; boundary=/.test(seen.at(-1).init.headers['content-type']));
r = await call('/v1/files', { headers: H });
check('other Groq endpoints blocked', r.status === 404);
let hits = 0; const limited = { ...env, LIMITER: { limit: async ({ key }) => ({ success: ++hits <= 2 && key === 'phone1' }) } };
await call('/v1/models', { headers: H }, limited); await call('/v1/models', { headers: H }, limited); r = await call('/v1/models', { headers: H }, limited);
check('per-phone rate limit', r.status === 429);
r = await call('/v1/models', { headers: H }, { APP_TOKEN: 'tok' });
check('missing key reported', r.status === 500);
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
