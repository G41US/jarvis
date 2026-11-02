// navlib.js - JS port of nav.py: worldwide geocoding + routing + spoken formatting. Same behaviour, same outputs.
import { pyRound, nominatimThrottle } from './net.js';

export const NAV_DEFAULTS = {
  valhalla_url: 'https://valhalla1.openstreetmap.de/route',
  osrm_urls: { auto: 'https://routing.openstreetmap.de/routed-car', bicycle: 'https://routing.openstreetmap.de/routed-bike', pedestrian: 'https://routing.openstreetmap.de/routed-foot' },
  osrm_car_backup: 'https://router.project-osrm.org',
  nominatim_url: 'https://nominatim.openstreetmap.org',
  photon_url: 'https://photon.komoot.io',
  user_agent: 'JarvisNavigation/1.0 (personal use)',
  units: 'auto', language: 'en-US', timeout_s: 12, max_points: 12, near_box_deg: 0.6,
};
export const MODES = ['auto', 'bicycle', 'pedestrian', 'motor_scooter'];
const MILES_COUNTRIES = new Set(['us', 'gb', 'lr', 'mm']);
export const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

// ------------------------------------------------------------------ geometry
export function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000.0, p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function compass(b) {
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return names[Math.floor((((b % 360) + 360) % 360 + 22.5) / 45) % 8];
}
export function decodePolyline(s, precision = 6) {
  const coords = []; let index = 0, lat = 0, lng = 0; const factor = 10 ** precision, n = s.length;
  while (index < n) {
    for (let which = 0; which < 2; which++) {
      let shift = 0, result = 0, b;
      do { b = s.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
export function encodePolyline(points, precision = 6) {
  let out = ''; const factor = 10 ** precision; let plat = 0, plng = 0;
  for (const [la, lo] of points) {
    const ilat = Math.round(la * factor), ilng = Math.round(lo * factor);
    for (let v of [ilat - plat, ilng - plng]) {
      v = v < 0 ? ~(v << 1) : (v << 1);
      while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      out += String.fromCharCode(v + 63);
    }
    plat = ilat; plng = ilng;
  }
  return out;
}

// ---------------------------------------------------------------- formatting
export function resolveUnits(setting, cc) {
  const s = String(setting || 'auto').toLowerCase();
  if (['miles', 'mi', 'imperial'].includes(s)) return 'miles';
  if (['km', 'kilometers', 'kilometres', 'metric'].includes(s)) return 'km';
  return MILES_COUNTRIES.has(String(cc || '').toLowerCase()) ? 'miles' : 'km';
}
function trimZero(v) { return v.endsWith('.0') ? v.slice(0, -2) : v; }
export function fmtDistance(m, units = 'miles', short = false) {
  m = Math.max(0, Number(m));
  if (units === 'miles') {
    const ft = m * FEET_PER_METER;
    if (ft < 1000) {
      const v = ft >= 25 ? Math.max(50, pyRound(ft / 50) * 50) : Math.max(10, pyRound(ft / 10) * 10);
      return short ? `${v} ft` : `${v} feet`;
    }
    const mi = m / METERS_PER_MILE;
    const v = mi >= 10 ? String(pyRound(mi)) : trimZero(mi.toFixed(1));
    return short ? `${v} mi` : `${v} mile${v === '1' ? '' : 's'}`;
  }
  if (m < 1000) {
    const v = m >= 25 ? Math.max(50, pyRound(m / 50) * 50) : Math.max(10, pyRound(m / 10) * 10);
    return short ? `${v} m` : `${v} meters`;
  }
  const km = m / 1000;
  const v = km >= 10 ? String(pyRound(km)) : trimZero(km.toFixed(1));
  return short ? `${v} km` : `${v} kilometer${v === '1' ? '' : 's'}`;
}
export function fmtDuration(s) {
  s = Math.max(0, pyRound(s));
  if (s < 90) return s >= 45 ? 'about a minute' : 'under a minute';
  const mins = pyRound(s / 60);
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60), mm = mins % 60;
  return `${h} hour${h !== 1 ? 's' : ''}` + (mm ? ` ${mm} minutes` : '');
}
/** 4:05 PM style, from epoch seconds, in local time (plain ASCII space so the voice reads it cleanly). */
export function clock(ts) {
  const d = new Date(ts * 1000); let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

// ------------------------------------------------------------ maneuver icons
const VAL_ICONS = { 0: 'straight', 1: 'depart', 2: 'depart', 3: 'depart', 4: 'arrive', 5: 'arrive_right', 6: 'arrive_left', 7: 'straight', 8: 'straight',
  9: 'slight_right', 10: 'right', 11: 'sharp_right', 12: 'uturn', 13: 'uturn_left', 14: 'sharp_left', 15: 'left', 16: 'slight_left', 17: 'straight',
  18: 'exit_right', 19: 'exit_left', 20: 'exit_right', 21: 'exit_left', 22: 'straight', 23: 'fork_right', 24: 'fork_left', 25: 'merge', 26: 'roundabout',
  27: 'roundabout', 28: 'ferry', 29: 'ferry', 37: 'merge', 38: 'merge' };
export const valhallaIcon = t => VAL_ICONS[parseInt(t, 10)] || 'straight';
export function osrmIcon(mtype, mod) {
  mod = (mod || '').toLowerCase();
  if (mtype === 'depart') return 'depart';
  if (mtype === 'arrive') return { left: 'arrive_left', right: 'arrive_right' }[mod] || 'arrive';
  if (['roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary'].includes(mtype)) return 'roundabout';
  if (mtype === 'merge') return 'merge';
  if (mtype === 'fork') return mod.includes('left') ? 'fork_left' : mod.includes('right') ? 'fork_right' : 'straight';
  if (mtype === 'off ramp') return mod.includes('left') ? 'exit_left' : 'exit_right';
  if (mtype === 'on ramp') return { left: 'slight_left', 'slight left': 'slight_left', right: 'slight_right', 'slight right': 'slight_right' }[mod] || 'straight';
  return { uturn: 'uturn', 'sharp right': 'sharp_right', right: 'right', 'slight right': 'slight_right', straight: 'straight',
    'slight left': 'slight_left', left: 'left', 'sharp left': 'sharp_left' }[mod] || 'straight';
}
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export function osrmText(step, first) {
  const m = step.maneuver || {}, t = m.type || '', mod = (m.modifier || '').toLowerCase();
  const name = (step.name || '').trim() || (step.ref || '').trim();
  const onto = name ? ` onto ${name}` : '', on = name ? ` on ${name}` : '';
  if (t === 'depart' || first) { const b = m.bearing_after; return b != null ? `Head ${compass(b)}${on}.` : `Head out${on}.`; }
  if (t === 'arrive') return `You have arrived at your destination${mod === 'left' ? ' on your left' : mod === 'right' ? ' on your right' : ''}.`;
  if (t === 'roundabout' || t === 'rotary') {
    const ex = m.exit, word = Number.isInteger(ex) && ex > 0 && ex < ORD.length ? ORD[ex] : '';
    return word ? `Enter the roundabout and take the ${word} exit${onto}.` : `Enter the roundabout and exit${onto}.`;
  }
  if (t === 'roundabout turn') return `At the roundabout, turn ${mod || 'ahead'}${onto}.`;
  if (t === 'exit roundabout' || t === 'exit rotary') return `Exit the roundabout${onto}.`;
  if (t === 'merge') return `Merge ${mod}${onto}.`.replace('merge straight', 'Merge');
  if (t === 'on ramp') return `Take the ramp${onto}.`;
  if (t === 'off ramp') return `Take the exit${mod && mod !== 'straight' ? ' ' + mod : ''}${onto}.`;
  if (t === 'fork') return `Keep ${mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : 'straight'} at the fork${onto}.`;
  if (t === 'end of road') return `At the end of the road, turn ${mod}${onto}.`;
  if (mod === 'uturn') return `Make a U-turn${onto}.`;
  if ((t === 'new name' || t === 'continue') && (mod === '' || mod === 'straight')) return `Continue${onto}.`;
  if (['turn', 'continue', 'new name'].includes(t) && mod) return mod !== 'straight' ? `Turn ${mod}${onto}.` : `Continue${onto}.`;
  return `Continue${onto}.`;
}

// --------------------------------------------------------------- navigator
const r1 = x => Math.round(x * 10) / 10;
export class Navigator {
  /** http: async (url, params, body) -> parsed JSON | null.  noThrottle: tests. */
  constructor(cfg = {}, http = null, { noThrottle = false } = {}) {
    this.cfg = { ...NAV_DEFAULTS, ...cfg };
    this.http = http; this.noThrottle = noThrottle; this._rev = new Map(); this.lastError = '';
  }
  async _throttle() { if (!this.noThrottle) await nominatimThrottle(); }
  static parseLatLon(text) {
    const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text || '');
    if (m) { const la = parseFloat(m[1]), lo = parseFloat(m[2]); if (la >= -90 && la <= 90 && lo >= -180 && lo <= 180) return [la, lo]; }
    return null;
  }
  _hit(r) {
    const a = r.address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.county || '';
    const area = [town, a.state || a.region || ''].filter(Boolean).join(', ');
    const street = `${a.house_number || ''} ${a.road || ''}`.trim();
    const name = r.name || '', disp = r.display_name || '';
    return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), display: disp, short: name || street || (disp ? disp.split(',')[0].trim() : ''),
      area, country_code: String(a.country_code || '').toLowerCase() };
  }
  async geocode(text, near = null) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const ll = Navigator.parseLatLon(text);
    if (ll) { const rev = (await this.reverse(ll[0], ll[1])) || {}; return { lat: ll[0], lon: ll[1], display: rev.display || text, short: rev.short || text, area: rev.area || '', country_code: rev.country_code || '', distance_km: null }; }
    const hasNum = /\d/.test(text), base = this.cfg.nominatim_url + '/search', tries = [];
    if (near) { const d = Number(this.cfg.near_box_deg); tries.push({ q: text, viewbox: `${near[1] - d},${near[0] + d},${near[1] + d},${near[0] - d}`, bounded: 1 }); }
    tries.push({ q: text });
    let hits = [];
    for (const extra of tries) {
      const params = { format: 'jsonv2', limit: (hasNum || !near) ? 1 : 8, addressdetails: 1, ...extra };
      await this._throttle();
      const res = await this.http(base, params);
      if (Array.isArray(res) && res.length) { hits = res.filter(r => 'lat' in r && 'lon' in r).map(r => this._hit(r)); if (hits.length) break; }
    }
    if (!hits.length) {
      const params = { q: text, limit: 1 }; if (near) { params.lat = near[0]; params.lon = near[1]; }
      const res = await this.http(this.cfg.photon_url + '/api/', params);
      const feats = (res && typeof res === 'object' && !Array.isArray(res) && res.features) || [];
      for (const f of feats.slice(0, 1)) {
        const [lon, lat] = f.geometry.coordinates, p = f.properties || {};
        const disp = [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(', ');
        hits.push({ lat: parseFloat(lat), lon: parseFloat(lon), display: disp || text,
          short: p.name || `${p.housenumber || ''} ${p.street || ''}`.trim() || text,
          area: [p.city, p.state].filter(Boolean).join(', '), country_code: String(p.countrycode || '').toLowerCase() });
      }
    }
    if (!hits.length) return null;
    if (near) { for (const h of hits) h.distance_km = haversineM(near[0], near[1], h.lat, h.lon) / 1000; hits.sort((a, b) => a.distance_km - b.distance_km); }
    const best = hits[0]; if (best.distance_km === undefined) best.distance_km = null;
    return best;
  }
  async reverse(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (this._rev.has(key)) return this._rev.get(key);
    await this._throttle();
    const res = await this.http(this.cfg.nominatim_url + '/reverse', { lat, lon, format: 'jsonv2', zoom: 18, addressdetails: 1 });
    if (!res || typeof res !== 'object' || Array.isArray(res) || !('lat' in res)) return null;
    const h = this._hit(res), a = res.address || {};
    h.short = `${a.house_number || ''} ${a.road || ''}`.trim() || res.name || h.short;
    this._rev.set(key, h);
    return h;
  }

  // ---- routing
  async route(points, mode = 'auto', units = 'km', language = null, avoid = []) {
    const pts = points.map(([a, b]) => [Number(a), Number(b)]);
    if (pts.length < 2) return { ok: false, error: 'I need a start and a destination.' };
    if (pts.length > Number(this.cfg.max_points)) return { ok: false, error: `That is more than ${this.cfg.max_points} stops.` };
    if (!MODES.includes(mode)) mode = 'auto';
    const lang = language || this.cfg.language || 'en-US';
    const r = await this._valhalla(pts, mode, units, lang, avoid);
    if (r.ok) return r;
    const err = r.error || '';
    if (r.hard && !r.far) return { ok: false, error: err };              // too far for Valhalla: OSRM has no distance limit
    const o = await this._osrm(pts, mode, units, avoid);
    if (o.ok) return o;
    return { ok: false, error: err || o.error || "The routing service isn't reachable right now." };
  }
  static modeWord(mode) { return { auto: 'driving', bicycle: 'cycling', pedestrian: 'walking', motor_scooter: 'scooter' }[mode] || mode; }
  async _valhalla(pts, mode, units, lang, avoid) {
    const body = { locations: pts.map(([lat, lon]) => ({ lat, lon })), costing: mode,
      directions_options: { units: units === 'miles' ? 'miles' : 'kilometers', language: lang }, id: 'jarvis' };
    const co = {};
    if (avoid.includes('highways')) co.use_highways = 0.0;
    if (avoid.includes('tolls')) co.use_tolls = 0.0;
    if (avoid.includes('ferries')) co.use_ferry = 0.0;
    if (Object.keys(co).length && (mode === 'auto' || mode === 'motor_scooter')) body.costing_options = { [mode]: co };
    const data = await this.http(this.cfg.valhalla_url, null, body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '' };
    if (!('trip' in data)) {
      const msg = String(data.error || ''), code = data.error_code;
      if (code === 154 || code === 153 || msg.toLowerCase().includes('exceeds'))
        return { ok: false, hard: true, far: true, error: "That's farther than the free routing service allows. I can open it in Google or Apple Maps instead." };
      if ([442, 443, 171, 170].includes(code) || msg.toLowerCase().includes('no path') || msg.toLowerCase().includes('no suitable edges'))
        return { ok: false, hard: true, error: `I couldn't find a ${Navigator.modeWord(mode)} route between those places.` };
      return { ok: false, error: '' };
    }
    try { return this._parseValhalla(data.trip, pts, mode, units, lang); }
    catch (e) { console.warn('[NAV] valhalla parse', e); return { ok: false, error: '' }; }
  }
  _parseValhalla(trip, pts, mode, units, lang) {
    const toM = ['miles', 'mi'].includes(trip.units || units) ? METERS_PER_MILE : 1000.0;
    const shape = [], steps = [], legs = [];
    trip.legs.forEach((leg, li) => {
      const lp = decodePolyline(leg.shape, 6), off = shape.length ? shape.length - 1 : 0;
      if (shape.length) shape.push(...lp.slice(1)); else shape.push(...lp);
      const first = steps.length;
      for (const m of (leg.maneuvers || [])) {
        steps.push({ i: steps.length, type: parseInt(m.type || 0, 10), icon: valhallaIcon(m.type || 0), text: m.instruction || '',
          say: m.verbal_pre_transition_instruction || m.instruction || '', alert: m.verbal_transition_alert_instruction || '',
          after: m.verbal_post_transition_instruction || '', street: (m.street_names || []).join(', '),
          dist_m: r1(parseFloat(m.length || 0) * toM), time_s: r1(parseFloat(m.time || 0)),
          begin: off + parseInt(m.begin_shape_index || 0, 10), end: off + parseInt(m.end_shape_index || 0, 10), leg: li, exit: m.roundabout_exit_count ?? null });
      }
      const ls = leg.summary || {};
      legs.push({ dist_m: r1(parseFloat(ls.length || 0) * toM), time_s: r1(parseFloat(ls.time || 0)), first_step: first, last_step: steps.length - 1, end_index: shape.length - 1 });
    });
    const s = trip.summary || {};
    return this._finish({ provider: 'valhalla' }, shape, steps, legs, pts, mode, units, lang, parseFloat(s.length || 0) * toM, parseFloat(s.time || 0));
  }
  async _osrm(pts, mode, units, avoid) {
    const base = this.cfg.osrm_urls[(mode === 'bicycle' || mode === 'pedestrian') ? mode : 'auto'];
    const bases = [base]; if (mode === 'auto' || mode === 'motor_scooter') bases.push(this.cfg.osrm_car_backup);
    const coords = pts.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(';');
    const params = { overview: 'full', geometries: 'polyline6', steps: 'true', alternatives: 'false' };
    const ex = [['motorway', 'highways'], ['toll', 'tolls'], ['ferry', 'ferries']].filter(([, k]) => avoid.includes(k)).map(([c]) => c);
    if (ex.length && (mode === 'auto' || mode === 'motor_scooter')) params.exclude = ex.join(',');
    for (const b of bases) {
      const data = await this.http(`${b}/route/v1/driving/${coords}`, params);
      if (data && typeof data === 'object' && data.code === 'Ok' && data.routes && data.routes.length) {
        try { return this._parseOsrm(data.routes[0], pts, mode, units); } catch (e) { console.warn('[NAV] osrm parse', e); }
      } else if (data && typeof data === 'object' && data.code === 'NoRoute') {
        return { ok: false, error: `I couldn't find a ${Navigator.modeWord(mode)} route between those places.` };
      }
    }
    return { ok: false, error: '' };
  }
  _parseOsrm(rt, pts, mode, units) {
    const shape = [], steps = [], legs = [];
    rt.legs.forEach((leg, li) => {
      const first = steps.length;
      leg.steps.forEach((st, si) => {
        let g = st.geometry ? decodePolyline(st.geometry, 6) : [];
        if ((st.maneuver || {}).type === 'arrive' && shape.length) g = [];
        if (shape.length && g.length && Math.abs(shape[shape.length - 1][0] - g[0][0]) < 1e-7 && Math.abs(shape[shape.length - 1][1] - g[0][1]) < 1e-7) g = g.slice(1);
        const begin = shape.length ? Math.max(0, shape.length - 1) : 0;
        shape.push(...g);
        const m = st.maneuver || {}, mtype = m.type || '', mod = m.modifier || '';
        const text = osrmText(st, li === 0 && si === 0);
        steps.push({ i: steps.length, type: 0, icon: osrmIcon(mtype, mod), text, say: text, alert: '', after: '', street: st.name || st.ref || '',
          dist_m: r1(parseFloat(st.distance || 0)), time_s: r1(parseFloat(st.duration || 0)), begin, end: Math.max(begin, shape.length - 1), leg: li, exit: m.exit ?? null });
        if (mtype === 'arrive') { const k = steps[steps.length - 1]; k.begin = k.end = Math.max(0, shape.length - 1); }
      });
      legs.push({ dist_m: r1(parseFloat(leg.distance || 0)), time_s: r1(parseFloat(leg.duration || 0)), first_step: first, last_step: steps.length - 1, end_index: Math.max(0, shape.length - 1) });
    });
    return this._finish({ provider: 'osrm' }, shape, steps, legs, pts, mode, units, 'en-US', parseFloat(rt.distance || 0), parseFloat(rt.duration || 0));
  }
  _finish(base, shape, steps, legs, pts, mode, units, lang, distM, timeS) {
    if (shape.length < 2) throw new Error('empty shape');
    const lats = shape.map(p => p[0]), lons = shape.map(p => p[1]);
    const r5 = x => Math.round(x * 1e5) / 1e5;
    return { ...base, ok: true, mode, units, language: lang, distance_m: r1(distM), time_s: r1(timeS),
      shape: shape.map(([a, b]) => [r5(a), r5(b)]), steps, legs,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      waypoints: pts.map(([a, b]) => ({ lat: a, lon: b })), created: Date.now() / 1000 };
  }
  static spokenSummary(route, label, now = null) {
    now = now || Date.now() / 1000;
    const units = route.units || 'miles', arrive = clock(now + route.time_s);
    const first = route.steps.find(s => !s.icon.startsWith('arrive'));
    let txt = `Navigating to ${label}. ${fmtDuration(route.time_s)} and ${fmtDistance(route.distance_m, units)}, arriving about ${arrive}.`;
    if (first && first.say) txt += ' ' + first.say;
    return txt;
  }
}
