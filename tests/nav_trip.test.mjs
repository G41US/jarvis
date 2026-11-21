// Several pickups on one trip go in the fastest order on the map; asking for directions never gets a made-up route.
import assert from 'node:assert/strict';
import { createNavService, bestOrder } from '../app/src/main/assets/www/local/navsvc.js';
import { NAV_ASK } from '../app/src/main/assets/www/local/brain.js';
import { Registry } from '../app/src/main/assets/www/local/tools.js';

assert.deepEqual(bestOrder([[0, 10, 20, 5], [10, 0, 4, 9], [20, 4, 0, 30], [5, 9, 30, 0]]), [3, 1, 2]);
assert.deepEqual(bestOrder([[0, 7], [7, 0]]), [1]);

const PLACES = { 'chicken republic': [9.07, 7.48], shoprite: [9.0, 7.40], 'jabi lake mall': [9.074, 7.42] };
const sent = [];
const NAV = {
  geocode: async q => { const p = PLACES[String(q).toLowerCase().trim()]; return p ? { lat: p[0], lon: p[1], short: q, display: q } : null; },
  route: async pts => ({ ok: true, time_s: 900 * (pts.length - 1), distance_m: 6000 * (pts.length - 1), units: 'km', steps: [{ icon: 'depart', say: 'Head north.' }], pts }),
  reverse: async () => null, cfg: { units: 'km' },
};
const delivery = { units: 'km', hasActive: () => false, _setState() {}, setUnits() {},
  matrix: async pts => [pts.map(a => pts.map(b => Math.hypot(a[0] - b[0], a[1] - b[1]) * 1e5))] };
const store = {}, config = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };
const reg = new Registry();
const nav = createNavService({ reg, config, delivery, broadcast: m => sent.push(m), openUrl() {}, navigator: NAV });
await nav.position({ lat: 9.06, lon: 7.47, acc: 10 });

// the voice command, no AI: "pick up at Shoprite and Chicken Republic" -> Chicken Republic first (it's nearer), then Shoprite
let out = await nav.fastpath('I need to pick up at Shoprite and Chicken Republic');
assert.match(out, /^Fastest way: Chicken Republic, then Shoprite\./, out);
assert.deepEqual(nav.state.dest.map(d => d[2]), ['Chicken Republic', 'Shoprite']);
const routeMsg = JSON.parse(sent.filter(m => m.startsWith('nav:')).pop().slice(4));
assert.equal(routeMsg.cmd, 'route'); assert.equal(routeMsg.route.waypoints.length, 3);

// arriving at the first pickup moves on to the next
await nav.position({ lat: 9.07, lon: 7.48, acc: 10 });
assert.deepEqual(nav.state.dest.map(d => d[2]), ['Shoprite']);
assert.ok(sent.some(m => /You're at Chicken Republic\. Next, Shoprite\./.test(m)));

// the AI's tool: destination plus stops
out = await reg.exec('navigate_to', JSON.stringify({ destination: 'Jabi Lake Mall', stops: ['Shoprite'] }));
assert.match(out, /^Fastest way: /);
out = await nav.fastpath('I need to pick up a delivery in Shoprite'); assert.doesNotMatch(out, /Fastest way/); assert.equal(nav.state.dest[0][2], 'Shoprite');
// a single place still works, and a name with "and" in it that isn't two places falls back to one place
out = await nav.fastpath('navigate to Jabi Lake Mall'); assert.doesNotMatch(out, /Fastest way/);

for (const t of ['give me directions to Wuse', 'I need to pick up a delivery in Gwagwalada', 'whats the fastest way to Jabi', 'take me to Shoprite']) assert.ok(NAV_ASK.test(t), t);
for (const t of ['what time is it', 'play some music']) assert.ok(!NAV_ASK.test(t), t);
process.stdout.write('nav trip OK\n');
