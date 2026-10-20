// delivery.js - JS port of delivery.py: stacks up to 4 orders and finds the best stop order.
// You accept orders in the driver app; Jarvis only plans. (DoorDash / Uber Eats / Grubhub have no driver API.)
import { haversineM, clock as clockOf, METERS_PER_MILE } from './navlib.js';
import { pyRound, nominatimThrottle } from './net.js';

export const MAX_STACK = 4;
export const DEFAULTS = {
  areas: [], country_codes: '',                      // your town comes from GPS (or the 'Busy areas' setting)
  pickup_dwell_s: 150, same_stop_dwell_s: 30, drop_dwell_s: 120,
  fresh_limit_min: 20, hard_limit_min: 35, late_weight: 3.0, cold_weight: 1.0, hard_weight: 4.0,
  default_deadline_min: 45, traffic_factor: 1.15, fallback_kmh: 40.0, detour_factor: 1.35,
  min_per_mile: 1.50, currency: '$', units: 'auto', min_per_hour: 18.0,
  osrm_url: 'https://router.project-osrm.org', user_agent: 'JarvisDeliveryCopilot/1.0 (personal use)',
};
const PLATFORM_ALIASES = { doordash: 'DoorDash', 'door dash': 'DoorDash', dd: 'DoorDash', dasher: 'DoorDash', ubereats: 'Uber Eats', 'uber eats': 'Uber Eats',
  uber: 'Uber Eats', grubhub: 'Grubhub', 'grub hub': 'Grubhub', instacart: 'Instacart', shipt: 'Shipt', spark: 'Spark' };
const titleCase = s => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
export function normalizePlatform(p) { const k = String(p || '').trim().toLowerCase(); return !k ? 'DoorDash' : (PLATFORM_ALIASES[k] || titleCase(k)); }
export const shortAddr = a => String(a || '').split(',')[0].trim() || 'the address';
export function tidyAddr(a) {
  a = String(a || '').replace(/\s+/g, ' ').trim();
  return a.split(' ').map(w => (/^\d/.test(w) || (w === w.toUpperCase() && w !== w.toLowerCase()) ? w : (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))).join(' ');
}
export function looksComplete(text) {
  const t = text.trim();
  if (/\b\d{5}(-\d{4})?\b/.test(t)) return true;
  if (/,\s*[A-Za-z .'-]+,\s*[A-Za-z]{2}\b/.test(t)) return true;
  if (/,\s*(KY|OH|WV|VA|TN|IN|Kentucky|Ohio|West Virginia)\b/i.test(t)) return true;
  return (t.match(/,/g) || []).length >= 2;
}
/** How exact a found place is. Nominatim's place_rank: 30 = a building or business, 26-27 = a street, lower = an area. */
export function precisionOf(hit) {
  if (!hit || hit.rank === undefined || hit.rank === null) return 'exact';            // unknown: treat as exact (as before)
  return hit.rank >= 28 ? 'exact' : hit.rank >= 25 ? 'street' : 'area';
}
/** "near the Tempe Marketplace", "somewhere around Arcadia", "off Main Street" -> the place itself */
export function cleanPlace(text) {
  return String(text || '').replace(/^\s*(?:somewhere\s+)?(?:near|by|around|close to|next to|behind|across from|off|in|at|the area (?:of|around|near))\s+/i, '')
    .replace(/^the\s+/i, '').replace(/\s+(?:area|side|neighbou?rhood|vicinity)\s*$/i, '').replace(/\s+/g, ' ').trim();
}
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const dayKey = ts => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class Copilot {
  /** kv: {get,set}. opts: {broadcast, http, matrixFn, noThrottle}. http(url, params) -> JSON|null (async). */
  constructor(kv, cfg = {}, { broadcast = () => {}, http = null, matrixFn = null, noThrottle = false } = {}) {
    this.kv = kv; this.cfg = { ...DEFAULTS, ...cfg }; this.broadcast = broadcast; this.http = http; this.matrixFn = matrixFn;
    this.noThrottle = noThrottle; this._matrixCache = new Map(); this._lastPlan = null;
    const u = String(this.cfg.units || 'auto').toLowerCase();
    this.units = ['km', 'kilometers', 'kilometres', 'metric'].includes(u) ? 'km' : 'miles';
    this._unitsFixed = ['miles', 'mi', 'km', 'kilometers', 'kilometres', 'metric'].includes(u);
    this._warnedNoStart = false;
  }
  // -- units / money
  get unitM() { return this.units === 'km' ? 1000.0 : METERS_PER_MILE; }
  get unitWord() { return this.units === 'km' ? 'kilometers' : 'miles'; }
  get unitShort() { return this.units === 'km' ? 'km' : 'mi'; }
  setUnits(u) { if (this._unitsFixed) return; this.units = u === 'km' ? 'km' : 'miles'; this._lastPlan = null; }
  money(v, decimals = 2) { return `${this.cfg.currency || '$'}${Number(v).toFixed(decimals)}`; }

  // -- storage (one JSON blob; orders hold customer addresses only until delivered)
  _db() { const d = this.kv.get('delivery_db', null) || {}; return { orders: d.orders || [], nextId: d.nextId || 1, state: d.state || {}, geo: d.geo || {}, log: d.log || [] }; }
  _save(d) { this.kv.set('delivery_db', d); }
  _getState(k, def = null) { const v = this._db().state[k]; return v === undefined ? def : v; }
  _setState(k, v) { const d = this._db(); if (v === null || v === undefined) delete d.state[k]; else d.state[k] = v; this._save(d); }
  activeOrders() { return this._db().orders.filter(o => o.status === 'active' || o.status === 'picked').map(o => ({ ...o })); }
  hasActive() { return this.activeOrders().length > 0; }

  // -- geocoding
  async _get(url, params) { return this.http ? this.http(url, params) : null; }
  async _throttle() { if (!this.noThrottle) await nominatimThrottle(); }
  _viewbox() { const loc = this._getState('loc'); if (!loc) return null; const d = 0.25; return `${loc.lon - d},${loc.lat + d},${loc.lon + d},${loc.lat - d}`; }
  async _nominatim(q) {
    const params = { q, format: 'jsonv2', limit: 1, addressdetails: 1 };
    if (this.cfg.country_codes) params.countrycodes = this.cfg.country_codes;
    const vb = this._viewbox(); if (vb) params.viewbox = vb;
    await this._throttle();
    const res = await this._get('https://nominatim.openstreetmap.org/search', params);
    if (Array.isArray(res) && res.length) {
      const r = res[0], a = r.address || {};
      const town = a.city || a.town || a.village || a.hamlet || a.county || '';
      const area = `${town}, ${a.state || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
      const hit = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), display: r.display_name || q, area, short: `${a.house_number || ''} ${a.road || ''}`.trim() };
      if (r.place_rank !== undefined) { hit.rank = Number(r.place_rank); if (a.house_number) hit.rank = Math.max(hit.rank, 30); }
      if (a.road) hit.road = a.road;
      return hit;
    }
    return null;
  }
  async _photon(q) {
    const params = { q, limit: 1 }; const loc = this._getState('loc'); if (loc) { params.lat = loc.lat; params.lon = loc.lon; }
    const res = await this._get('https://photon.komoot.io/api/', params);
    const feats = (res && res.features) || [];
    if (feats.length) {
      const f = feats[0], [lon, lat] = f.geometry.coordinates, p = f.properties || {};
      const disp = [p.name, p.street, p.city, p.state].filter(Boolean).join(', ');
      const hit = { lat: parseFloat(lat), lon: parseFloat(lon), display: disp || q, area: `${p.city || ''}, ${p.state || ''}`.trim().replace(/^,\s*|,\s*$/g, ''),
        short: `${p.housenumber || ''} ${p.street || ''}`.trim() };
      const t = String(p.type || '').toLowerCase();
      hit.rank = p.housenumber ? 30 : t === 'street' ? 26 : ['city', 'county', 'state', 'country'].includes(t) ? 14 : ['district', 'locality', 'suburb', 'neighbourhood'].includes(t) ? 20 : 30;
      if (p.street || (t === 'street' && p.name)) hit.road = p.street || p.name;
      return hit;
    }
    return null;
  }
  _candidates(text) {
    if (looksComplete(text)) return [text];
    const cur = this._getState('area'); const areas = cur ? [cur] : [...this.cfg.areas];
    return [...areas.map(a => `${text}, ${a}`), text];
  }
  async geocode(text, cache = true) {
    text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text) return null;
    const key = text.toLowerCase(), useCache = cache && /\d/.test(text);
    if (useCache) { const g = this._db().geo[key]; if (g) { const h = { lat: g.lat, lon: g.lon, display: g.display, area: '', short: shortAddr(g.display) }; if (g.rank !== undefined) h.rank = g.rank; return h; } }
    const cands = this._candidates(text); let hit = null;
    // a delivery stop is never hundreds of miles away: skip matches far from where the driver is (a different town's "Main Street")
    const loc = this._getState('loc'), near = h => !h || !loc || haversineM(loc.lat, loc.lon, h.lat, h.lon) < 150000;
    for (const q of cands) { const h = await this._nominatim(q); if (h && near(h)) { hit = h; break; } }
    if (!hit) for (const q of cands.slice(0, 2)) { const h = await this._photon(q); if (h && near(h)) { hit = h; break; } }
    if (hit && useCache) { const d = this._db(); d.geo[key] = { lat: hit.lat, lon: hit.lon, display: hit.display, ts: Date.now() / 1000 }; if (hit.rank !== undefined) d.geo[key].rank = hit.rank; this._save(d); }
    return hit;
  }
  /** A place, landmark or area is fine too: "near Tempe Marketplace", "Arcadia", "the Maple apartments on 5th". */
  async geocodeLoose(text, near = null) {
    const saved = this._viewbox;
    if (near) this._viewbox = () => { const d = 0.08; return `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`; };
    try {
      let hit = await this.geocode(text, false);
      const c = cleanPlace(text);
      if (!hit && c && c.toLowerCase() !== String(text).trim().toLowerCase()) hit = await this.geocode(c, false);
      if (!hit && c.includes(',')) hit = await this.geocode(c.split(',').slice(1).join(',').trim(), false);   // "Unit 4, Maple apartments, Tempe" -> the rest
      return hit;
    } finally { this._viewbox = saved; }
  }

  // -- routing matrix
  async matrix(pts) {
    if (this.matrixFn) return this.matrixFn(pts);
    const key = pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join('|');
    const hit = this._matrixCache.get(key);
    if (hit && Date.now() / 1000 - hit[0] < 600) return hit[1];
    const n = pts.length, tf = Number(this.cfg.traffic_factor);
    const D = Array.from({ length: n }, () => new Array(n).fill(0)), M = Array.from({ length: n }, () => new Array(n).fill(0));
    let source = 'osrm';
    const coords = pts.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(';');
    const data = await this._get(`${this.cfg.osrm_url}/table/v1/driving/${coords}`, { annotations: 'duration,distance' });
    const ok = !!(data && data.code === 'Ok' && data.durations && data.distances);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let d = null, m = null;
      if (ok) { d = data.durations[i][j]; m = data.distances[i][j]; }
      if (d == null || m == null) {
        source = 'estimate';
        const straight = haversineM(pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
        m = straight * Number(this.cfg.detour_factor); d = m / (Number(this.cfg.fallback_kmh) * 1000 / 3600);
      }
      D[i][j] = d * tf; M[i][j] = m;
    }
    const result = [D, M, source]; this._matrixCache.set(key, [Date.now() / 1000, result]); return result;
  }

  // -- optimizer: exhaustive over every stop order that puts each pickup before its drop-off
  async solve(orders, start, now) {
    const cfg = this.cfg, nodes = [];
    orders.forEach((o, oi) => {
      if (o.status === 'active') nodes.push({ kind: 'pickup', oi, lat: o.pickup_lat, lon: o.pickup_lon });
      nodes.push({ kind: 'drop', oi, lat: o.drop_lat, lon: o.drop_lon });
    });
    const N = nodes.length;
    const pts = [...(start ? [[start.lat, start.lon]] : []), ...nodes.map(n => [n.lat, n.lon])];
    const off = start ? 1 : 0;
    const [D, M, source] = await this.matrix(pts);
    nodes.forEach((n, k) => { n.mi = k + off; });
    const pickNode = {}; nodes.forEach((n, k) => { if (n.kind === 'pickup') pickNode[n.oi] = k; });
    const fresh = cfg.fresh_limit_min * 60, hard = cfg.hard_limit_min * 60;
    const pd = cfg.pickup_dwell_s, sd = cfg.same_stop_dwell_s, dd = cfg.drop_dwell_s;
    const deadlineOf = o => o.deadline_at ? o.deadline_at : (o.created_at || now) + cfg.default_deadline_min * 60;

    const evaluate = (seq, detail = false) => {
      let t = now, prevMi = start ? 0 : null, prevNode = null, dist = 0, pen = 0, lateTotal = 0; const rows = [];
      const pickedAt = {}; orders.forEach((o, oi) => { pickedAt[oi] = o.picked_at || now; });
      for (const k of seq) {
        const n = nodes[k]; let legS = 0, legM = 0;
        if (prevMi !== null) { legS = D[prevMi][n.mi]; legM = M[prevMi][n.mi]; }
        t += legS; dist += legM;
        const arrive = t; let wait = 0, late = 0, age = null, slack = null; const o = orders[n.oi];
        if (n.kind === 'pickup') {
          const ready = o.ready_at || now; wait = Math.max(0, ready - t); t += wait;
          const same = prevNode !== null && prevNode.kind === 'pickup' && haversineM(prevNode.lat, prevNode.lon, n.lat, n.lon) < 60;
          t += same ? sd : pd; pickedAt[n.oi] = t;
        } else {
          t += dd; age = t - pickedAt[n.oi]; late = Math.max(0, t - deadlineOf(o)); slack = deadlineOf(o) - t; lateTotal += late;
          pen += cfg.late_weight * late; pen += cfg.cold_weight * Math.max(0, age - fresh); pen += cfg.hard_weight * Math.max(0, age - hard);
        }
        if (detail) rows.push({ k, arrive, wait_s: wait, done: t, leg_s: legS, leg_m: legM, late_s: late, age_s: age, slack_s: slack });
        prevMi = n.mi; prevNode = n;
      }
      return [(t - now) + pen, t, dist, lateTotal, rows];
    };
    let bestSeq = null, bestCost = Infinity;
    const seq = [], used = new Set();
    const gen = () => {
      if (seq.length === N) { const c = evaluate(seq)[0]; if (c < bestCost - 1e-9) { bestCost = c; bestSeq = [...seq]; } return; }
      for (let k = 0; k < N; k++) {
        if (used.has(k)) continue; const nd = nodes[k];
        if (nd.kind === 'drop' && (nd.oi in pickNode) && !used.has(pickNode[nd.oi])) continue;
        used.add(k); seq.push(k); gen(); seq.pop(); used.delete(k);
      }
    };
    gen();
    const [cost, tEnd, dist, lateTotal, rows] = evaluate(bestSeq, true);
    const naive = [...nodes.map((n, k) => [n, k]).filter(([n]) => n.kind === 'pickup').map(([, k]) => k), ...nodes.map((n, k) => [n, k]).filter(([n]) => n.kind === 'drop').map(([, k]) => k)];
    const [nCost, nEnd, , nLate] = evaluate(naive);

    const stops = [];
    rows.forEach((r, i) => {
      const n = nodes[r.k], o = orders[n.oi], isPick = n.kind === 'pickup', addr = isPick ? o.pickup_addr : o.drop_addr;
      const s = { seq: i + 1, kind: n.kind, order_id: o.id ?? null, platform: o.platform, restaurant: o.restaurant,
        label: isPick ? `Pick up at ${o.restaurant}` : `Drop off ${o.restaurant} order`, addr, short_addr: shortAddr(addr), lat: n.lat, lon: n.lon,
        eta_ts: r.arrive, eta_clock: clockOf(r.arrive), mins: Math.max(0, pyRound((r.arrive - now) / 60)), wait_min: pyRound(r.wait_s / 60),
        leg_min: r1(r.leg_s / 60), leg_mi: r1(r.leg_m / this.unitM), late_min: pyRound(r.late_s / 60),
        food_age_min: r.age_s === null ? null : pyRound(r.age_s / 60) };
      if (!isPick && o.drop_precision) { s.approx = o.drop_precision; s.short_addr = `near ${shortAddr(addr)}`; }
      const el = Math.max(0, r.arrive - now), spread = Math.max(60, 0.15 * el);
      s.eta_lo = clockOf(r.arrive - 0.6 * spread); s.eta_hi = clockOf(r.arrive + 1.6 * spread);
      s.mins_lo = Math.max(0, pyRound((el - 0.6 * spread) / 60)); s.mins_hi = pyRound((el + 1.6 * spread) / 60);
      if (!isPick) {
        const slackMin = r.slack_s / 60, margin = (1.6 * spread) / 60;
        s.slack_min = pyRound(slackMin);
        s.risk = slackMin < 0.5 * margin ? 'high' : slackMin < 1.5 * margin + 2 ? 'medium' : 'low';
      }
      stops.push(s);
    });
    const payout = orders.reduce((a, o) => a + Number(o.payout || 0), 0), totalS = tEnd - now, miles = dist / this.unitM;
    const plan = { ok: true, source, generated_at: now, orders: orders.length, stops, total_min: pyRound(totalS / 60), total_s: totalS,
      total_miles: r1(miles), payout: r2(payout), currency: this.cfg.currency || '$', unit: this.unitShort, unit_word: this.unitWord,
      per_hour: totalS > 60 && payout ? r2(payout / (totalS / 3600)) : 0.0, per_mile: miles > 0.05 && payout ? r2(payout / miles) : 0.0,
      late_total_s: lateTotal, naive_total_min: pyRound((nEnd - now) / 60), naive_late_min: pyRound(nLate / 60), best_late_min: pyRound(lateTotal / 60),
      saved_min: Math.max(0, pyRound((nEnd - tEnd) / 60)), late_avoided_min: Math.max(0, pyRound((nLate - lateTotal) / 60)),
      cold_avoided: nCost - cost > 600 && nEnd - tEnd < 60, start, warnings: [] };
    for (const s of stops) {
      if (s.kind === 'drop' && s.late_min >= 2) plan.warnings.push(`${s.restaurant} order will be about ${s.late_min} minutes late.`);
      if (s.kind === 'drop' && s.food_age_min && s.food_age_min > cfg.fresh_limit_min) plan.warnings.push(`${s.restaurant} food will sit in the bag about ${s.food_age_min} minutes.`);
      if (s.kind === 'pickup' && s.wait_min >= 3) plan.warnings.push(`Expect to wait about ${s.wait_min} minutes at ${s.restaurant}.`);
    }
    if (source === 'estimate') plan.warnings.push('Map service unreachable, so times are straight-line estimates.');
    const rough = stops.filter(s => s.approx);
    if (rough.length) plan.warnings.push(`${rough.map(s => s.restaurant).join(' and ')} drop-off${rough.length > 1 ? 's are' : ' is'} approximate (area only), so times there are rough.`);
    const rank = { low: 0, medium: 1, high: 2 }, risks = stops.filter(s => s.risk).map(s => s.risk);
    plan.risk = risks.length ? risks.reduce((a, b) => (rank[b] > rank[a] ? b : a)) : 'low';
    plan.total_min_lo = Math.max(0, pyRound(totalS / 60 - 0.6 * Math.max(1, 0.15 * totalS / 60)));
    plan.total_min_hi = pyRound(totalS / 60 + 1.6 * Math.max(1, 0.15 * totalS / 60));
    plan.no_start = start === null || start === undefined;
    plan.nav_url = Copilot.navUrl(stops, start);
    return plan;
  }
  static navUrl(stops, start) {
    if (!stops.length) return '';
    const pts = stops.map(s => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`), q = { api: '1', travelmode: 'driving', destination: pts[pts.length - 1] };
    if (pts.length > 1) q.waypoints = pts.slice(0, -1).join('|');
    if (start) q.origin = `${start.lat.toFixed(6)},${start.lon.toFixed(6)}`;
    return 'https://www.google.com/maps/dir/?' + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',').replace(/%7C/g, '|')}`).join('&');
  }

  // -- public
  static sig(orders) { return orders.map(o => `${o.id}:${o.status}`).join(','); }
  async plan(now = null) {
    now = now || Date.now() / 1000; const orders = this.activeOrders();
    if (!orders.length) { this._lastPlan = null; return { ok: false, error: 'No active orders.' }; }
    const plan = await this.solve(orders, this._getState('loc'), now);
    this._lastPlan = [Copilot.sig(orders), plan]; return plan;
  }
  async push(plan = null) {
    try { if (plan === null) plan = await this.plan(); this.broadcast('route:' + JSON.stringify(plan.ok ? plan : {})); }
    catch (e) { console.warn('[DELIVERY] push fail', e); }
  }
  async setLocation(text) {
    const g = await this.geocode(text, false); if (!g) return null;
    this._setState('loc', { lat: g.lat, lon: g.lon, label: shortAddr(text) }); if (g.area) this._setState('area', g.area); return g;
  }
  static pickupLabel(pickup, geo, restaurant) { return pickup ? tidyAddr(pickup) : (geo.short || restaurant); }
  async addOrder(restaurant, dropoff, pickup = '', payout = 0, platform = '', readyInMin = 0, withinMin = 0, now = null) {
    now = now || Date.now() / 1000; restaurant = String(restaurant || '').trim() || 'the restaurant';
    if (this.activeOrders().length >= MAX_STACK) return { ok: false, error: `Stack is full at ${MAX_STACK} orders. Finish one first.` };
    const p = await this.geocode(pickup || restaurant); if (!p) return { ok: false, error: `Couldn't find ${pickup || restaurant}. Give me its street address.` };
    const d = await this.geocodeLoose(dropoff); if (!d) return { ok: false, error: `Couldn't find ${dropoff}. Tell me a nearby street, landmark or neighbourhood and I'll use that until you have the number.` };
    const precision = precisionOf(d);
    payout = Number(payout); payout = Number.isFinite(payout) ? Math.max(0, payout) : 0;
    const db = this._db(), id = db.nextId++;
    db.orders.push({ id, platform: normalizePlatform(platform), restaurant, pickup_addr: Copilot.pickupLabel(pickup, p, restaurant), pickup_lat: p.lat, pickup_lon: p.lon,
      drop_addr: tidyAddr(dropoff), drop_lat: d.lat, drop_lon: d.lon, payout, ready_at: now + Math.max(0, Number(readyInMin || 0)) * 60,
      deadline_at: (withinMin && Number(withinMin) > 0) ? now + Number(withinMin) * 60 : null, status: 'active', picked_at: null, created_at: now, area: d.area || '' });
    if (precision !== 'exact') Object.assign(db.orders[db.orders.length - 1], { drop_precision: precision, drop_road: d.road || '', drop_area: d.area || '' });
    this._save(db); this._lastPlan = null;
    const out = { ok: true, id, restaurant, pickup: Copilot.pickupLabel(pickup, p, restaurant), dropoff: tidyAddr(dropoff), count: this.activeOrders().length };
    if (precision !== 'exact') out.approx = precision;
    return out;
  }
  /** Fill in or correct a drop-off later: "1420" (the number on the street we already have) or a full / better address. */
  async updateAddress(ref, text) {
    const all = this.activeOrders();
    let o = ref ? this.findOrder(ref) : null;
    if (!o) { const rough = all.filter(x => x.drop_precision); o = rough.length ? rough[rough.length - 1] : (all.length === 1 ? all[0] : null); }
    if (!o) return { ok: false, error: all.length ? 'Which order is that for?' : 'No active orders.' };
    let q = String(text || '').replace(/\s+/g, ' ').trim();
    if (!q) return { ok: false, error: 'What is the address?' };
    const num = /^(?:number\s+|#\s*)?(\d+[a-z]?)$/i.exec(q);
    if (num) {
      if (!o.drop_road) return { ok: false, error: `I only have the area for the ${o.restaurant} order, not a street. Tell me the number and the street.` };
      q = `${num[1]} ${o.drop_road}${o.drop_area ? ', ' + o.drop_area : ''}`;
    }
    const near = { lat: o.drop_lat, lon: o.drop_lon };
    const g = await this.geocodeLoose(q, near);
    if (!g) return { ok: false, error: `Couldn't find ${q}. Check the number and street?` };
    const precision = precisionOf(g), moved = haversineM(near.lat, near.lon, g.lat, g.lon);
    const db = this._db(), row = db.orders.find(x => x.id === o.id);
    Object.assign(row, { drop_addr: tidyAddr(q), drop_lat: g.lat, drop_lon: g.lon });
    if (precision === 'exact') { delete row.drop_precision; delete row.drop_road; delete row.drop_area; }
    else Object.assign(row, { drop_precision: precision, drop_road: g.road || row.drop_road || '', drop_area: g.area || row.drop_area || '' });
    this._save(db); this._lastPlan = null;
    return { ok: true, id: o.id, restaurant: o.restaurant, dropoff: tidyAddr(q), precision, moved_m: Math.round(moved) };
  }
  findOrder(ref) {
    const orders = this.activeOrders(); ref = String(ref ?? '').trim().toLowerCase(); if (!ref) return null;
    if (/^\d+$/.test(ref)) { const o = orders.find(x => x.id === parseInt(ref, 10)); if (o) return o; }
    return orders.find(o => o.restaurant.toLowerCase().includes(ref)) || null;
  }
  removeOrder(ref) { const o = this.findOrder(ref); if (!o) return null; const d = this._db(); d.orders = d.orders.filter(x => x.id !== o.id); this._save(d); return o; }
  clear() { const d = this._db(), n = d.orders.length; d.orders = []; this._save(d); this._lastPlan = null; return n; }
  async completeNext(ref = '', kind = '', now = null) {
    now = now || Date.now() / 1000; const orders = this.activeOrders();
    if (!orders.length) return { ok: false, error: 'No active orders.' };
    kind = String(kind || '').trim().toLowerCase(); let order, stopKind, legMi = 0;
    if (ref) {
      order = this.findOrder(ref); if (!order) return { ok: false, error: `No active order matching ${ref}.` };
      if (kind === 'pickup' && order.status === 'picked') return { ok: false, error: `${order.restaurant} is already marked as picked up.` };
      stopKind = kind || (order.status === 'active' ? 'pickup' : 'drop');
      const lp = this._lastPlan; let st = null;
      if (lp && lp[0] === Copilot.sig(orders)) st = (lp[1].stops || []).find(x => x.order_id === order.id && x.kind === stopKind) || null;
      legMi = (st && st.leg_mi) || 0;
    } else {
      const lp = this._lastPlan; let stops;
      if (lp && lp[0] === Copilot.sig(orders) && (lp[1].stops || []).length) stops = lp[1].stops; else stops = (await this.plan(now)).stops;
      const stop = stops.find(s => !kind || s.kind === kind);
      if (!stop) return { ok: false, error: `Nothing left to ${kind === 'pickup' ? 'pick up' : 'drop off'}.` };
      order = orders.find(o => o.id === stop.order_id); stopKind = stop.kind; legMi = stop.leg_mi || 0;
    }
    const snap = { db: JSON.stringify(this._db()), loc: this._getState('loc'), miles: this._getState('shift_miles') };   // for "undo"
    const [lat, lon, addr] = stopKind === 'pickup' ? [order.pickup_lat, order.pickup_lon, order.pickup_addr] : [order.drop_lat, order.drop_lon, order.drop_addr];
    this._setState('loc', { lat, lon, label: shortAddr(addr) });
    if (legMi) {
      const day = dayKey(now), cur = this._getState('shift_miles') || {}, base = cur.day === day ? (cur.mi || 0) : 0;
      this._setState('shift_miles', { day, mi: r2(base + Number(legMi)) });
    }
    const db = this._db(); let msg;
    if (stopKind === 'pickup') { const o = db.orders.find(x => x.id === order.id); o.status = 'picked'; o.picked_at = now; msg = { kind: 'pickup', restaurant: order.restaurant }; }
    else {
      db.log.push({ platform: order.platform, restaurant: order.restaurant, payout: order.payout, accepted_at: order.created_at, delivered_at: now, area: order.area || order.drop_area || '' });   // the town only, for the Earnings page
      db.orders = db.orders.filter(x => x.id !== order.id);                 // the customer's address is gone
      msg = { kind: 'drop', restaurant: order.restaurant, payout: order.payout };
    }
    this._save(db); this._lastPlan = null; msg.ok = true; this._undo = { snap, msg, at: now }; return msg;
  }
  /** Put back the last stop marked done (within 15 minutes): "undo", "not yet". */
  undoLast(now = null) {
    now = now || Date.now() / 1000; const u = this._undo; if (!u || now - u.at > 900) return null;
    this._save(JSON.parse(u.snap.db)); if (u.snap.loc) this._setState('loc', u.snap.loc); if (u.snap.miles) this._setState('shift_miles', u.snap.miles);
    this._undo = null; this._lastPlan = null; return u.msg;
  }
  earnings(now = null) {
    now = now || Date.now() / 1000; const d0 = new Date(now * 1000); const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime() / 1000;
    const rows = this._db().log.filter(r => r.delivered_at >= midnight);
    if (!rows.length) return { count: 0, total: 0.0, per_hour: 0.0, by_platform: {}, miles: 0.0, hours: 0.0, per_mile: 0.0 };
    const total = rows.reduce((a, r) => a + (r.payout || 0), 0);
    const spanH = Math.max(0, (Math.max(...rows.map(r => r.delivered_at)) - Math.min(...rows.map(r => r.accepted_at))) / 3600);
    const by = {}; for (const r of rows) by[r.platform] = r2((by[r.platform] || 0) + (r.payout || 0));
    const cur = this._getState('shift_miles') || {}, miles = cur.day === dayKey(now) ? (cur.mi || 0) : 0;
    return { count: rows.length, total: r2(total), per_hour: spanH > 0.1 ? r2(total / spanH) : 0.0, by_platform: by, miles: r1(miles), hours: r1(spanH), per_mile: miles > 0.5 ? r2(total / miles) : 0.0 };
  }
  async evaluateOffer(restaurant, dropoff, pickup = '', payout = 0, platform = '', readyInMin = 0, now = null) {
    now = now || Date.now() / 1000; const orders = this.activeOrders();
    if (orders.length >= MAX_STACK) return { ok: false, error: `Stack is already full at ${MAX_STACK} orders.` };
    const p = await this.geocode(pickup || restaurant), d = dropoff ? await this.geocode(dropoff, false) : null;
    if (!p) return { ok: false, error: `Couldn't find ${pickup || restaurant}.` };
    if (!d) return { ok: false, error: 'I need a drop-off address or at least the street to judge this offer.' };
    payout = Number(payout); payout = Number.isFinite(payout) ? Math.max(0, payout) : 0;
    const hypo = { id: -1, platform: normalizePlatform(platform), restaurant: restaurant || 'New offer', pickup_addr: Copilot.pickupLabel(pickup, p, restaurant), pickup_lat: p.lat, pickup_lon: p.lon,
      drop_addr: tidyAddr(dropoff), drop_lat: d.lat, drop_lon: d.lon, payout, ready_at: now + Math.max(0, Number(readyInMin || 0)) * 60, deadline_at: null, status: 'active', picked_at: null, created_at: now };
    const start = this._getState('loc');
    const base = orders.length ? await this.solve(orders, start, now) : null, withp = await this.solve([...orders, hypo], start, now);
    const extraS = withp.total_s - (base ? base.total_s : 0), extraMi = withp.total_miles - (base ? base.total_miles : 0);
    const extraLate = (withp.late_total_s - (base ? base.late_total_s : 0)) / 60;
    const out = { ok: true, plan: withp, extra_min: pyRound(extraS / 60), extra_miles: r1(extraMi), payout, extra_late_min: pyRound(extraLate), per_hour: 0.0, per_mile: 0.0,
      risk: withp.risk || 'low', risk_before: (base || {}).risk || 'low' };
    if (payout > 0 && extraS > 60) out.per_hour = r2(payout / (extraS / 3600));
    if (payout > 0 && extraMi > 0.05) out.per_mile = r2(payout / extraMi);
    const okHr = out.per_hour >= this.cfg.min_per_hour, okMi = out.per_mile >= this.cfg.min_per_mile;
    if (payout <= 0) out.verdict = 'unknown'; else if (extraLate >= 3) out.verdict = 'decline';
    else if (okHr && okMi) out.verdict = 'take'; else if (okHr || okMi) out.verdict = 'marginal'; else out.verdict = 'decline';
    if (out.verdict === 'take' && out.risk === 'high') out.verdict = 'marginal';
    return out;
  }

  // -- speech
  spokenPlan(plan) {
    if (!plan.ok) return plan.error || 'No plan.';
    const parts = plan.stops.map(s => s.kind === 'pickup' ? `${s.seq}, pick up ${s.restaurant}, ${s.eta_clock}` : `${s.seq}, drop ${s.short_addr}, ${s.eta_clock}`);
    let txt = `Best route for ${plan.orders} order${plan.orders !== 1 ? 's' : ''}: ${parts.join('; ')}. About ${plan.total_min} minutes and ${plan.total_miles} ${this.unitWord}`;
    if (plan.payout) { txt += `, ${this.money(plan.payout)} total`; if (plan.per_hour) txt += `, roughly ${this.money(plan.per_hour, 0)} an hour`; }
    txt += '.';
    if (plan.total_min_hi) txt += ` Expect ${plan.total_min_lo} to ${plan.total_min_hi} minutes. On-time risk is ${plan.risk}.`;
    if (plan.saved_min >= 2) txt += ` That saves about ${plan.saved_min} minutes of driving over taking them in the order you got them.`;
    if ((plan.late_avoided_min || 0) >= 3) txt += ` It also avoids about ${plan.late_avoided_min} minutes of lateness.`;
    else if (plan.cold_avoided) txt += ' It also keeps the food from sitting in the bag.';
    if (plan.warnings.length) txt += ' Heads up: ' + plan.warnings.slice(0, 3).join(' ');
    if (plan.no_start && !this._warnedNoStart) { this._warnedNoStart = true; txt += " I don't know where you are, so I assumed you're at the first pickup. Tell me your address for exact times."; }
    return txt;
  }
  static arrive(s) {
    if (s.mins <= 0) return `You're there by ${s.eta_clock}.`;
    if ((s.mins_hi || 0) > s.mins + 1) return `Arrive about ${s.eta_clock}, ${s.mins_lo} to ${s.mins_hi} minutes.`;
    return `Arrive about ${s.eta_clock}, ${s.mins} minute${s.mins !== 1 ? 's' : ''}.`;
  }
  spokenNext(plan) {
    if (!plan.ok) return plan.error || 'No active orders.';
    const s = plan.stops[0]; let txt;
    if (s.kind === 'pickup') { txt = `Next, pick up ${s.restaurant} at ${s.short_addr}. ` + Copilot.arrive(s); if (s.wait_min >= 2) txt += ` Food won't be ready for about ${s.wait_min} more minutes after you arrive.`; }
    else txt = `Next, drop off the ${s.restaurant} order at ${s.short_addr}. ` + Copilot.arrive(s);
    if (plan.stops.length > 1) { const n = plan.stops[1]; txt += ` After that, ${n.kind === 'pickup' ? 'pick up ' + n.restaurant : 'drop at ' + n.short_addr}.`; }
    return txt;
  }
  spokenOrders() {
    const orders = this.activeOrders(); if (!orders.length) return 'No active orders.';
    const bits = orders.map(o => `${o.id}, ${o.restaurant} on ${o.platform} to ${shortAddr(o.drop_addr)}${o.payout ? ', ' + this.money(o.payout) : ''}, ${o.status === 'picked' ? 'picked up' : 'waiting for pickup'}`);
    return `${orders.length} active: ${bits.join('; ')}.`;
  }
}
