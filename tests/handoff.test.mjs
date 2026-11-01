// node tests/handoff.test.mjs - phone <-> PC handoff: the phone's tools against the real Jarvis service code (server/worker.js)
import worker from '../server/worker.js';
import { BUILD } from '../app/src/main/assets/www/local/build_config.js';
import { registerHandoff, lastLines, readBack } from '../app/src/main/assets/www/local/handoff.js';
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + x)); if (!c) fails++; };

const store = new Map();
const env = { GROQ_API_KEY: 'gsk', APP_TOKEN: 'tok', UPDATES: { get: async (k, t) => { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
  put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); } } };
const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), env);
const reg = { fns: {}, add(n, d, p, r, fn) { this.fns[n] = fn; } };
const kvs = new Map(), kv = { get: (k, d) => (kvs.has(k) ? kvs.get(k) : d), set: (k, v) => kvs.set(k, v) };
BUILD.apiBase = 'https://jarvis-proxy.example.workers.dev/v1'; BUILD.appToken = 'tok';
const h = registerHandoff({ reg, kv, api: { device: () => 'phone-1' }, fetchImpl });

check('not linked yet: says how to link', /link my PC/.test(await reg.fns.continue_from_pc()));
const said = await reg.fns.link_pc();
const code = (said.match(/link code ([\d ]+)\./) || [])[1] || '';
check('phone says a 6-digit code, digit by digit', /^\d( \d){5}$/.test(code.trim()), said);
// the PC claims it, the way server.py does
const claim = await fetchImpl('https://jarvis-proxy.example.workers.dev/link/claim', { method: 'POST', body: JSON.stringify({ code }) });
const { pair } = await claim.json();
check('the PC gets the same secret the phone kept', claim.status === 200 && pair === kv.get('handoff_pair'));
await h.push([{ role: 'system', content: 'x' }, { role: 'user', content: 'find me a pizza place near the office' }, { role: 'assistant', content: 'Three options, sir.' }]);
const phoneSide = await (await fetchImpl(`https://jarvis-proxy.example.workers.dev/hand/${pair}?from=phone`)).json();
check('phone kept its lines (not the system prompt)', phoneSide.messages.length === 2 && phoneSide.messages[0].content.includes('pizza'));
await fetchImpl(`https://jarvis-proxy.example.workers.dev/hand/${pair}?from=pc`, { method: 'PUT', body: JSON.stringify({ at: Date.now() - 5 * 60000, messages: [{ role: 'user', content: 'draft an email to Tunde about Friday' }, { role: 'assistant', content: 'Draft ready, sir.' }] }) });
const back = await reg.fns.continue_from_pc();
check('phone carries on from the PC', back.includes('Tunde') && /5 minutes ago/.test(back), back);
check('lines are clipped and limited', lastLines(Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'x'.repeat(900) + i }))).length === 12 && lastLines([{ role: 'user', content: 'y'.repeat(900) }])[0].content.length === 400);
check('nothing yet reads as empty', readBack({ messages: [] }) === '');
store.delete(`pair:${pair}`);
check('an expired link says so and forgets it', /expired/.test(await reg.fns.continue_from_pc()) && !kv.get('handoff_pair'));
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
