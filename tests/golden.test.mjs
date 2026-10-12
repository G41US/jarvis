// node tests/golden.test.mjs  (TZ=UTC)  -- the JS ports must reproduce the Python engines' outputs exactly.
import fs from 'fs';
import * as N from '../app/src/main/assets/www/local/navlib.js';
import { Copilot } from '../app/src/main/assets/www/local/delivery.js';
import { makeKV } from '../app/src/main/assets/www/local/net.js';
const G = JSON.parse(fs.readFileSync(new URL('./golden.json', import.meta.url)));
let fails = 0;
const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== '' ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); if (!c) fails++; };
function eq(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6 ? null : `${path}: ${a} != ${b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  for (const k of new Set([...ka, ...kb])) { const e = eq(a[k], b[k], path + '.' + k); if (e) return e; }
  return null;
}
const same = (n, a, b) => { const e = eq(a, b); check(n, e === null, e); };

// ---- formatting
let bad = G.fmt_distance.filter(([m, u, s, want]) => N.fmtDistance(m, u, s) !== want).map(([m, u, s, w]) => [m, u, s, w, N.fmtDistance(m, u, s)]);
check(`fmt_distance x${G.fmt_distance.length}`, bad.length === 0, bad.slice(0, 5));
bad = G.fmt_duration.filter(([s, want]) => N.fmtDuration(s) !== want);
check('fmt_duration', bad.length === 0, bad);
bad = G.compass.filter(([b, want]) => N.compass(b) !== want);
check('compass', bad.length === 0, bad);
bad = G.units.filter(([s, c, want]) => N.resolveUnits(s, c) !== want);
check('resolve_units', bad.length === 0, bad);
const pts = [[51.5074, -0.1278], [-33.8688, 151.2093], [35.6762, 139.6503], [0, 0], [-1.25, -78.5]];
check('polyline encode identical', N.encodePolyline(pts, 6) === G.polyline, [N.encodePolyline(pts, 6), G.polyline]);
same('polyline decode identical', N.decodePolyline(G.polyline, 6), G.polyline_decoded);
same('google reference polyline', N.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5).map(p => p.map(x => Math.round(x * 1e5) / 1e5)), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);

// ---- routes
const A = [51.50, -0.12], C = [51.51, -0.10], D = [51.52, -0.10];
let sentBody = null;
let nav = new N.Navigator({}, async (url, params, body) => { sentBody = body; return G.valhalla_fixture; }, { noThrottle: true });
let r = await nav.route([A, C, D], 'auto', 'miles', null, ['tolls']); delete r.created;
same('valhalla route == python', r, G.valhalla_route);
same('valhalla request body == python', sentBody, G.valhalla_body);
check('spoken summary == python', N.Navigator.spokenSummary({ ...r }, 'Test Place', 1760000000) === G.summary, [N.Navigator.spokenSummary({ ...r }, 'Test Place', 1760000000), G.summary]);
nav = new N.Navigator({}, async (url) => url.includes('valhalla') ? null : G.osrm_fixture, { noThrottle: true });
r = await nav.route([A, C], 'auto', 'km'); delete r.created;
same('osrm fallback route == python', r, G.osrm_route);
nav = new N.Navigator({}, async () => ({ error: 'No path could be found', error_code: 442 }), { noThrottle: true });
r = await nav.route([A, C], 'auto', 'km'); check('no-path message', !r.ok && r.error.includes("couldn't find a driving route"), r);
nav = new N.Navigator({}, async () => null, { noThrottle: true });
r = await nav.route([A, C], 'auto', 'km'); check('offline message', !r.ok && /isn't reachable/.test(r.error), r);

// ---- geocoding
const hit = { lat: '6.45', lon: '3.39', display_name: 'Lagos, Nigeria', name: 'Lagos', address: { city: 'Lagos', country_code: 'ng' } };
nav = new N.Navigator({}, async (url, p) => url.includes('/search') ? [hit] : null, { noThrottle: true });
let g = await nav.geocode('Lagos'); check('geocode worldwide', g && g.country_code === 'ng' && Math.abs(g.lat - 6.45) < 1e-9, g);
nav = new N.Navigator({}, async (url, p) => url.includes('/search') ? [] : { features: [{ geometry: { coordinates: [139.69, 35.68] }, properties: { name: 'Tokyo Tower', city: 'Tokyo', countrycode: 'JP' } }] }, { noThrottle: true });
g = await nav.geocode('tokyo tower'); check('photon fallback', g && g.short === 'Tokyo Tower' && g.country_code === 'jp', g);
nav = new N.Navigator({}, async (url, p) => (url.includes('/search') && p.bounded) ? [{ lat: '51.51', lon: '-0.11', display_name: 'Starbucks near', address: {} }] : [{ lat: '40', lon: '-74', display_name: 'Starbucks far', address: {} }], { noThrottle: true });
g = await nav.geocode('starbucks', [51.50, -0.12]); check('nearby match beats far', g && g.display === 'Starbucks near' && g.distance_km < 5, g);
g = await new N.Navigator({}, async () => [], { noThrottle: true }).geocode('zzz nowhere'); check('nothing found -> null', g === null);
nav = new N.Navigator({}, async (u, p) => ({ lat: '51.5', lon: '-0.12', display_name: '10, Downing Street, London', address: { house_number: '10', road: 'Downing Street', city: 'London', country_code: 'gb' } }), { noThrottle: true });
g = await nav.geocode('51.5, -0.12'); check('lat,lon geocode via reverse', g && g.short === '10 Downing Street' && g.country_code === 'gb', g);

// ---- delivery scenario (same fake town + fake matrix as the Python tests)
const PLACES = { 'taco bell': [38.6400, -83.7600], 'pizza hut': [38.6420, -83.7500], 'subway': [38.6405, -83.7598], '100 elm st': [38.6500, -83.7300],
  '200 oak st': [38.6300, -83.7700], '300 pine st': [38.6600, -83.7200], '400 main st': [38.6350, -83.7550], '500 far rd': [38.7500, -83.6000], 'home base': [38.6410, -83.7580] };
const fakeHttp = async (url, params) => {
  if (url.includes('nominatim')) {
    const q = params.q.toLowerCase();
    for (const [name, [la, lo]] of Object.entries(PLACES)) if (q.startsWith(name))
      return [{ lat: String(la), lon: String(lo), display_name: '100, Elm Street, Maysville, Kentucky', address: { city: 'Maysville', state: 'Kentucky', house_number: '12', road: 'Main Street' } }];
    return [];
  }
  return null;
};
const fakeMatrix = async pts => {
  const n = pts.length, D = Array.from({ length: n }, () => new Array(n).fill(0)), M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) { const m = N.haversineM(...pts[i], ...pts[j]) * 1.3; M[i][j] = m; D[i][j] = m / (30000 / 3600); }
  return [D, M, 'test'];
};
const NOW = G.delivery_now, Gd = G.delivery;
const c = new Copilot(makeKV(), { currency: '$' }, { http: fakeHttp, matrixFn: fakeMatrix, noThrottle: true });
c._setState('loc', { lat: 38.6410, lon: -83.7580, label: 'home base' });
const adds = [await c.addOrder('Taco Bell', '100 elm st', '', 9, 'doordash', 0, 0, NOW), await c.addOrder('Pizza Hut', '300 pine st', '', 12, 'ubereats', 6, 0, NOW),
  await c.addOrder('Subway', '200 oak st', '', 8, 'grubhub', 0, 25, NOW)];
same('add orders == python', adds, Gd.adds);
const p = await c.plan(NOW);
same('plan == python (stops, ETAs, risk, savings)', p, Gd.plan);
check('spoken plan == python', c.spokenPlan(p) === Gd.spoken_plan, [c.spokenPlan(p), Gd.spoken_plan]);
check('spoken next == python', c.spokenNext(p) === Gd.spoken_next, [c.spokenNext(p), Gd.spoken_next]);
check('spoken orders == python', c.spokenOrders() === Gd.spoken_orders, [c.spokenOrders(), Gd.spoken_orders]);
let ev = await c.evaluateOffer('Subway', '400 main st', '', 14, 'doordash', 0, NOW); const evp = { ...ev }; delete evp.plan;
same('offer verdict == python', evp, Gd.offer); check('offer plan total', ev.plan.total_min === Gd.offer_plan_total);
ev = await c.evaluateOffer('Subway', '500 far rd', '', 4, 'doordash', 0, NOW); const evq = { ...ev }; delete evq.plan; same('bad offer verdict == python', evq, Gd.offer_far);
const steps = []; let t = NOW + 300;
for (let i = 0; i < 6; i++) { steps.push(await c.completeNext('', '', t)); if (!c.hasActive()) break; t += 400; }
same('complete stops == python', steps, Gd.completes);
same('earnings == python', c.earnings(t), Gd.earnings);
same('location follows the last stop', c._getState('loc'), Gd.after_state_loc);
check('stack empty at the end', !c.hasActive());
// limits and edge cases
const c2 = new Copilot(makeKV(), {}, { http: fakeHttp, matrixFn: fakeMatrix, noThrottle: true });
for (const n of ['Taco Bell', 'Subway', 'Pizza Hut', 'Taco Bell']) await c2.addOrder(n, '100 elm st', '', 5, 'doordash', 0, 0, NOW);
const fifth = await c2.addOrder('Subway', '100 elm st'); check('stack limit of 4', !fifth.ok && /full at 4/.test(fifth.error), fifth);
check('km units + currency', (() => { const c3 = new Copilot(makeKV(), { currency: '₦' }, { noThrottle: true }); c3.setUnits('km'); return c3.unitWord === 'kilometers' && c3.money(1500, 0) === '₦1500'; })());
console.log('\nFAILURES:', fails);
process.exit(fails ? 1 : 0);
