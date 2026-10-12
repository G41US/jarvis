// node tests/approx.test.mjs - orders with only a place or area, filled in later
import { Copilot, precisionOf, cleanPlace } from '../app/src/main/assets/www/local/delivery.js';
import { Registry } from '../app/src/main/assets/www/local/tools.js';
import { registerDeliveryTools } from '../app/src/main/assets/www/local/tools_delivery.js';
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + JSON.stringify(x))); if (!c) fails++; };
const mem = {}; const kv = { get: (k, d) => (k in mem ? JSON.parse(mem[k]) : d), set: (k, v) => { mem[k] = JSON.stringify(v); } };
const A = { city: 'Tempe', state: 'Arizona' };
// a tiny fake OpenStreetMap: what Nominatim returns, including place_rank (30 = building/business, 26 = street, 18 = neighbourhood)
const PLACES = [
  [/^1420 mill avenue/, { lat: 33.4180, lon: -111.9400, place_rank: 30, address: { house_number: '1420', road: 'Mill Avenue', ...A } }],
  [/^mill avenue/, { lat: 33.4200, lon: -111.9395, place_rank: 26, address: { road: 'Mill Avenue', ...A } }],
  [/^arcadia/, { lat: 33.4990, lon: -111.9800, place_rank: 18, address: { suburb: 'Arcadia', city: 'Phoenix', state: 'Arizona' } }],
  [/^tempe marketplace/, { lat: 33.4300, lon: -111.9000, place_rank: 30, address: { ...A } }],
  [/^chipotle/, { lat: 33.4220, lon: -111.9390, place_rank: 30, address: { road: 'Mill Avenue', ...A } }],
  [/^panda express/, { lat: 33.4250, lon: -111.9300, place_rank: 30, address: { ...A } }],
  [/^22b 5th street/, { lat: 33.4255, lon: -111.9380, place_rank: 30, address: { house_number: '22B', road: '5th Street', ...A } }],
];
const seen = [];
const http = async (url, params) => {
  if (!url.includes('nominatim')) return url.includes('photon') ? { features: [] } : null;
  const q = String(params.q).toLowerCase(); seen.push(q);
  for (const [re, r] of PLACES) if (re.test(q)) return [{ lat: String(r.lat), lon: String(r.lon), display_name: q, place_rank: r.place_rank, address: r.address }];
  return [];
};
const matrixFn = async pts => { const n = pts.length, D = pts.map(() => new Array(n).fill(300)), M = pts.map(() => new Array(n).fill(2000)); for (let i = 0; i < n; i++) { D[i][i] = 0; M[i][i] = 0; } return [D, M, 'test']; };
const c = new Copilot(kv, {}, { http, matrixFn, noThrottle: true });
c._setState('loc', { lat: 33.4255, lon: -111.94, label: 'here' });

check('precision from place_rank', precisionOf({ rank: 30 }) === 'exact' && precisionOf({ rank: 26 }) === 'street' && precisionOf({ rank: 18 }) === 'area' && precisionOf({}) === 'exact');
check('"near the Tempe Marketplace area" -> "Tempe Marketplace"', cleanPlace('near the Tempe Marketplace area') === 'Tempe Marketplace' && cleanPlace('somewhere around Arcadia') === 'Arcadia');

let r = await c.addOrder('Chipotle', 'Arcadia', '', 9, 'doordash');
check('area only (Arcadia) is accepted, marked approximate', r.ok && r.approx === 'area', r);
let p = await c.plan();
const drop = p.stops.find(s => s.kind === 'drop');
check('route says "near Arcadia" and warns times are rough', drop.short_addr === 'near Arcadia' && drop.approx === 'area' && p.warnings.some(w => /approximate/.test(w)), [drop.short_addr, p.warnings]);
check('spoken route says "near"', /drop near Arcadia/.test(c.spokenPlan(p)), c.spokenPlan(p));
r = await c.updateAddress('', '1420');
check('a number alone with no street known -> asks for the street', !r.ok && /number and the street/.test(r.error), r);

r = await c.addOrder('Panda Express', 'Mill Avenue', '', 7, 'ubereats');
check('street only (Mill Avenue) is accepted as street-level', r.ok && r.approx === 'street', r);
const reg = new Registry(); const dt = registerDeliveryTools({ reg, delivery: c, navsvc: null, openUrl: () => {} });
const said = await dt.fastpath("it's 1420");
const o = c.activeOrders().find(x => x.restaurant === 'Panda Express');
check('"it\'s 1420" fills in 1420 Mill Avenue instantly (no AI) and makes it exact', /Got it: Panda Express goes to 1420 Mill Avenue/.test(said) && !o.drop_precision && Math.abs(o.drop_lat - 33.418) < 1e-6, [said, o]);
check('...looked up next to the old spot, in the same town', seen.includes('1420 mill avenue, tempe, arizona'), seen.slice(-3));

r = await c.updateAddress('chipotle', '22B 5th Street');
p = await c.plan();
check('a full address for the Arcadia order later -> exact, warning gone', r.ok && r.precision === 'exact' && !p.warnings.some(w => /approximate/.test(w)) && !p.stops.some(s => s.approx), [r, p.warnings]);

r = await c.addOrder('Chipotle', 'near the Tempe Marketplace', '', 6, 'doordash');
check('"near the Tempe Marketplace" finds the landmark (exact)', r.ok && !r.approx, r);
r = await c.addOrder('Chipotle', 'zzz nowhere', '', 6, 'doordash');
check('not found -> asks for a nearby street, landmark or neighbourhood (not "street number")', !r.ok && /landmark or neighbourhood/.test(r.error), r);
// a same-named street in another state is ignored; the driver's own town is used
PLACES.unshift([/^main street, tempe/, { lat: 33.4150, lon: -111.9350, place_rank: 26, address: { road: 'Main Street', ...A } }]);
PLACES.unshift([/^main street$/, { lat: 38.6400, lon: -83.7600, place_rank: 26, address: { road: 'Main Street', city: 'Maysville', state: 'Kentucky' } }]);
c._setState('area', 'Tempe, Arizona');
r = await c.addOrder('Panda Express', 'Main Street', '', 5, 'doordash');
const ms = c.activeOrders().find(x => x.id === r.id);
check('"Main Street" goes to the one in your town, not Kentucky', r.ok && Math.abs(ms.drop_lat - 33.415) < 1e-6, ms);
const c3 = new Copilot(kv, {}, { http, matrixFn, noThrottle: true }); c3._setState('loc', { lat: 6.5244, lon: 3.3792, label: 'Lagos' });
r = await c3.geocode('Main Street', false);
check('from Lagos, a Main Street in Kentucky is rejected (too far away)', r === null, r);
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
