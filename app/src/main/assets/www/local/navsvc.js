// navsvc.js - on-phone navigation service: port of the navigation block in server.py.
// Owns route requests, the delivery-stack route, map/voice controls, and the spoken-command fast path.
import { Navigator, haversineM, resolveUnits, fmtDistance, fmtDuration, clock } from './navlib.js';
import { currencyFor } from './delivery.js';

const MAP_ACTIONS = ['show_map', 'mini_map', 'hide_map', 'zoom_in', 'zoom_out', 'overview', 'recenter', 'night', 'day', 'auto_theme', 'mute_voice', 'unmute_voice',
  'simulate', 'stop_simulation', 'use_google', 'use_apple', 'use_jarvis_map', 'avoid_highways', 'avoid_tolls', 'avoid_ferries', 'allow_all_roads', 'gps_off', 'gps_on', 'reroute'];
/** Fastest order to visit every stop once, starting at 0, from a travel-time matrix D (row/column 0 = the start). Stops are 1..n. */
export function bestOrder(D) {
  const n = D.length - 1; let best = null, bestT = Infinity;
  const go = (path, left, t) => {
    if (t >= bestT) return;
    if (!left.length) { best = path; bestT = t; return; }
    for (const k of left) go([...path, k], left.filter(x => x !== k), t + D[path.length ? path[path.length - 1] : 0][k]);
  };
  go([], Array.from({ length: n }, (_, i) => i + 1), 0);
  return best || [];
}

/** How much to stretch our route times to match the traffic-aware time (kept between half and three times). */
export const trafficScale = (ours, live) => (ours > 0 && live > 0 ? Math.min(3, Math.max(0.5, live / ours)) : 1);

export const NO_ORIGIN = "I don't know where you are yet. Allow location for the app, or tell me 'I'm at' and your address.";

export function createNavService({ reg, config, delivery, broadcast, openUrl, navigator }) {
  const NAV = navigator;
  const S = { active: false, route: null, label: '', mode: 'auto', delivery: false, dest: [], pos: null, synced: null, rv: null, cc: '', progress: null, avoid: [], view: 'off' };
  const cmd = (c, kw = {}) => broadcast('nav:' + JSON.stringify({ cmd: c, ...kw }));
  const keys = () => ({ google: config.get('google_key', '') || '', apple: config.get('apple_token', '') || '' });
  const cfgOut = () => ({ provider: config.get('map_provider', 'jarvis'), theme: config.get('map_theme', 'auto'), units: delivery.units, use_gps: config.get('use_gps', true),
    google_key: keys().google, apple_token: keys().apple });

  // the phone's own GPS (Android): the map only feeds S.pos while it's open, so without this Jarvis didn't know where you were
  function phoneFix(fresh) {
    try {
      const P = typeof window !== 'undefined' && window.AndroidPhone; if (!P || !P.lastLocation) return null;
      const l = JSON.parse(fresh && P.freshLocation ? P.freshLocation(7000) : P.lastLocation());
      S.locWhy = (l && l.why) || (l && Number.isFinite(l.lat) ? 'old' : 'nofix');
      if (!l || !Number.isFinite(l.lat) || (l.age_s ?? 0) > (fresh ? 86400 : 1800) || (l.acc ?? 0) > 5000) return null;   // a fresh ask takes the best the phone has
      S.pos = { lat: l.lat, lon: l.lon, acc: l.acc || 50, ts: Date.now() / 1000 - (l.age_s || 0), speed: null };
      if (l.acc <= 200 && config.get('use_gps', true)) syncLocation(l.lat, l.lon).catch(() => {});
      return [l.lat, l.lon];
    } catch { return null; }
  }
  /** Why there's no position, in words that say what to do. */
  function noOrigin() {
    const P = typeof window !== 'undefined' && window.AndroidPhone, why = S.locWhy;
    if (why === 'permission') {
      let r = ''; try { r = P && P.request ? String(P.request('location')) : ''; } catch {}
      return r === 'settings' ? "I'm not allowed to use your location. On the screen that just opened, tap Permissions, then Location, then Allow only while using the app, and ask me again."
        : "I'm not allowed to use your location yet. Tap Allow on the window that just opened, then ask me again.";
    }
    if (why === 'off') { try { P && P.openSettings && P.openSettings('location'); } catch {} return "Your phone's location is switched off. Turn on Location, then ask me again."; }
    if (P && P.lastLocation) return "Your phone couldn't get a location fix just now. Try again in a few seconds, or tell me where you are.";
    return NO_ORIGIN;
  }
  /** Where you are now, waiting a few seconds for a GPS fix if the phone hasn't had one lately. */
  // "from my current location" means from here: map searches turn phrases like that into a random place abroad ("too far")
  const HERE = { test: t => t.length <= 45 && (/^(?:me|current|gps)$/i.test(t) || /\b(?:here|where (?:i|we)(?:'m| am| are|'re| is)|(?:my|our|the|this|me) (?:current |present |exact |live |actual |gps )?(?:location|position|spot|area|gps|coordinates|address now)|current (?:location|position|place|spot|address)|gps)\b/i.test(t)) };
  async function originNow() { return origin() || phoneFix(true); }
  function origin() {
    const p = S.pos;
    if (p && Date.now() / 1000 - p.ts < 300 && p.acc <= 200) return [p.lat, p.lon];
    const g = phoneFix(false); if (g) return g;
    const loc = delivery._getState('loc'); if (loc) return [loc.lat, loc.lon];
    if (p && p.acc <= 5000) return [p.lat, p.lon];
    return null;
  }
  const units = (cc = '') => { const u = resolveUnits((NAV.cfg.units || 'auto'), S.cc || cc); delivery.setUnits(u); return u; };
  const route = async (pts, mode) => withTraffic(await NAV.route(pts, mode, units(), null, S.avoid), pts, mode);
  // live traffic (a free TomTom key in Settings): the same roads, but times from current traffic, and the delivery planner
  // weighs stops by it too. Without a key, typical speeds as before.
  async function withTraffic(r, pts, mode) {
    const key = String(config.get('tomtom_key', '') || '').trim();
    if (!r || !r.ok || !key || mode !== 'auto' || pts.length > 150) return r;
    try {
      const locs = pts.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join(':');
      const j = await delivery._get(`https://api.tomtom.com/routing/1/calculateRoute/${locs}/json`, { key, traffic: 'true', travelMode: 'car', routeType: 'fastest', computeTravelTimeFor: 'all' });
      const sm = j && j.routes && j.routes[0] && j.routes[0].summary; if (!sm || !(sm.travelTimeInSeconds > 0)) return r;
      const k = trafficScale(r.time_s, sm.travelTimeInSeconds);
      r.time_s = Math.round(r.time_s * k); for (const st of r.steps || []) st.time_s = Math.round(st.time_s * k); for (const l of r.legs || []) l.time_s = Math.round(l.time_s * k);
      r.traffic = { delay_s: Math.max(0, Math.round(sm.trafficDelayInSeconds || 0)) };
      if (sm.noTrafficTravelTimeInSeconds > 0) delivery.cfg.traffic_factor = Math.min(3, Math.max(1, sm.travelTimeInSeconds / sm.noTrafficTravelTimeInSeconds));
    } catch (e) { console.warn('[NAV] traffic', e); }
    return r;
  }

  async function syncLocation(lat, lon) {
    const last = S.synced; if (last && haversineM(last[0], last[1], lat, lon) < 20) return;
    S.synced = [lat, lon];
    delivery._setState('loc', { lat, lon, label: 'GPS' });
    const rv = S.rv;
    if (!rv || haversineM(rv[0], rv[1], lat, lon) > 4000) {
      const info = await NAV.reverse(lat, lon);
      if (info) {
        S.rv = [lat, lon]; S.cc = info.country_code || ''; if (info.area) delivery._setState('area', info.area); units();
        const sym = currencyFor(S.cc);                                    // money in the local currency unless he picked one
        if (sym && String(config.get('currency_auto', 'true')) !== 'false' && config.get('currency', '') !== sym) { config.set('currency', sym); delivery.cfg.currency = sym; }
        S.place = [info.short, info.area].filter(Boolean).join(', '); S.placeAt = Date.now();
      }
    }
  }
  async function position(p) {
    const lat = parseFloat(p.lat), lon = parseFloat(p.lon); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false };
    const acc = parseFloat(p.acc) || 9999;
    S.pos = { lat, lon, acc, ts: Date.now() / 1000, speed: p.speed };
    if (acc <= 200 && config.get('use_gps', true)) syncLocation(lat, lon).catch(() => {});
    if (S.dashPending && acc <= 500) startDash().catch(() => {});
    watchStops(lat, lon, acc);
    return { ok: true };
  }
  const progress = p => { p.ts = Date.now() / 1000; S.progress = p; return { ok: true }; };

  // ---- knowing when a stop is done: you stop near it for a while, then drive away -> picked up / delivered.
  //      Only for stops with a real address (an area-only drop-off is too vague to tell), and you can say "undo".
  const ARRIVE_M = 120, LEAVE_M = 300, DWELL_MS = 40000;
  // the arrival card on the phone: "You're at Chipotle · Picked up"
  const arrived = detail => { try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('jv-arrive', { detail })); } catch {} };
  function watchStops(lat, lon, acc) {
    if (S.active && !S.delivery && S.dest.length > 1 && acc <= 100 && haversineM(lat, lon, S.dest[0][0], S.dest[0][1]) <= ARRIVE_M) {
      const done = S.dest.shift(); S.label = S.dest[0][2];          // a stop on a multi-stop trip: on to the next one
      broadcast('proactive:' + `You're at ${done[2]}. Next, ${S.dest[0][2]}.`); return;
    }
    if (!(S.active && S.delivery && S.route) || acc > 100 || !S.onStopDone || config.get('auto_stops', true) === false) return;
    const w = (S.route.waypoints || [])[1]; if (!w || w.approx || !w.kind || w.kind === 'stop') { S.here = null; return; }
    const d = haversineM(lat, lon, w.lat, w.lon), key = `${w.kind}:${w.label}`, now = Date.now();
    if (d <= ARRIVE_M) { if (!S.here || S.here.key !== key) { S.here = { key, since: now, last: now }; arrived({ kind: w.kind, label: w.label }); } else S.here.last = now; return; }
    if (S.here && S.here.key === key && d >= LEAVE_M) {
      const stayed = S.here.last - S.here.since; S.here = null; arrived(null);
      if (stayed >= (globalThis.__jvDwellMs || DWELL_MS)) { try { S.onStopDone(w.kind, w.label); } catch (e) { console.warn('[NAV] auto stop', e); } }
    }
  }

  // ---- "dash" view: while there are orders, the route card sits on top, a small map with directions to the next stop
  //      under it, and Jarvis's face shrinks to a corner. It starts by itself and goes away after the last drop-off.
  async function startDash() {
    if (S.active && !S.delivery) return 'busy';                         // already navigating somewhere else: leave it
    if (!delivery.hasActive() || S.dashMuted) return 'off';
    const org = origin();
    if (!org) { S.dashPending = true; S.view = 'dash'; cmd('view', { mode: 'dash' }); return 'waiting'; }   // the map starts GPS; the first fix routes it
    S.dashPending = false;
    const [r, info] = await buildDelivery(org);
    if (S.active && S.view === 'full') return 'busy';                   // full navigation started while this was routing: keep it
    if (r === null) { cmd('view', { mode: 'dash', center: org }); return info; }
    const wps = r.waypoints;
    Object.assign(S, { active: true, route: r, label: info, mode: 'auto', delivery: true, progress: null, view: 'dash', dest: wps.slice(1).map(w => [w.lat, w.lon, w.label]) });
    cmd('route', { route: r, meta: { label: info, delivery: true, view: 'dash' } });
    return 'on';
  }
  function endDash() { S.dashMuted = false; S.dashPending = false; S.here = null; if (S.view === 'dash' && !S.active) { S.view = 'off'; cmd('view', { mode: 'off' }); } }
  const ended = () => {
    if (!S.delivery) { S.active = false; S.route = null; S.progress = null; if (delivery.hasActive()) setTimeout(() => { if (!S.active) startDash().catch(() => {}); }, 13000); }   // back to the delivery map
    return { ok: true };
  };

  // ---- delivery-stack navigation
  function mergeStops(stops) {
    const out = [];
    for (const s of stops) {
      const lab = s.kind === 'pickup' ? s.restaurant : s.short_addr, last = out[out.length - 1];
      if (last && last.kind === s.kind && haversineM(last.lat, last.lon, s.lat, s.lon) < 40) { if (!last.label.includes(lab)) last.label += ' and ' + lab; continue; }
      out.push({ lat: s.lat, lon: s.lon, label: lab, kind: s.kind, approx: !!s.approx });
    }
    return out;
  }
  async function buildDelivery(org) {
    const plan = await delivery.plan(); if (!plan.ok) return [null, 'No active orders to navigate.'];
    let stops = mergeStops(plan.stops);
    if (haversineM(org[0], org[1], stops[0].lat, stops[0].lon) < 50) {
      const first = stops[0];
      if (stops.length === 1) return [null, `You're already at ${first.label}. ` + (first.kind === 'pickup' ? 'Say picked up when you have the order.' : 'Say delivered when it\'s dropped off.')];
      stops = stops.slice(1);
    }
    const r = await route([org, ...stops.map(s => [s.lat, s.lon])], 'auto');
    if (!r.ok) return [null, r.error];
    r.waypoints = [{ lat: org[0], lon: org[1], label: 'You', kind: 'stop' }, ...stops];
    return [r, stops[0].label];
  }
  async function startDelivery() {
    const org = await originNow(); if (!org) return noOrigin();
    const [r, info] = await buildDelivery(org); if (r === null) return info;
    const wps = r.waypoints;
    Object.assign(S, { active: true, route: r, label: info, mode: 'auto', delivery: true, progress: null, view: 'full', dest: wps.slice(1).map(w => [w.lat, w.lon, w.label]) });
    cmd('route', { route: r, meta: { label: info, delivery: true } });
    const n = wps.length - 1, first = r.steps.find(s => !s.icon.startsWith('arrive'));
    const txt = `Navigating to ${info}` + (n > 1 ? `, then ${n - 1} more stop${n > 2 ? 's' : ''}` : '') + `. ${fmtDuration(r.time_s)} and ${fmtDistance(r.distance_m, r.units)} for the whole run.`;
    return txt + (first && first.say ? ' ' + first.say : '');
  }
  async function refreshDelivery() {
    if (!(S.active && S.delivery)) return;
    try {
      const org = origin();
      if (!delivery.hasActive()) { const dash = S.view === 'dash'; Object.assign(S, { active: false, route: null, delivery: false, progress: null, view: 'off', here: null, dashMuted: false }); cmd('stop', { say: dash ? '' : 'That was the last stop. Navigation ended.' }); return; }
      const [r, info] = org ? await buildDelivery(org) : [null, noOrigin()];
      if (r === null) { console.warn('[NAV] delivery refresh:', info); return; }
      const wps = r.waypoints;
      Object.assign(S, { route: r, label: info, dest: wps.slice(1).map(w => [w.lat, w.lon, w.label]), progress: null });
      S.here = null;
      cmd('route', { route: r, meta: { label: info, delivery: true, reroute: false, view: 'keep' } });
    } catch (e) { console.warn('[NAV] delivery refresh failed', e); }
  }

  // ---- destination navigation
  async function resolve(text, org) {
    const key = String(text || '').trim().toLowerCase().replace(/^(my|the)\s+/, '');
    const p = (config.get('places', {}) || {})[key];
    if (p) return { lat: p.lat, lon: p.lon, short: key.replace(/\b\w/g, c => c.toUpperCase()), display: p.address || key, country_code: p.cc || '', distance_km: null };
    return NAV.geocode(text, org);
  }
  async function start(destText, mode = 'auto', fromText = '') {
    const tail = /^(.+?)\s+(?:starting\s+)?from\s+(.+)$/i.exec(String(destText || '').trim());   // "to Jabi Lake Mall from where I am"
    if (tail && !fromText && (HERE.test(tail[2].trim()) || tail[2].trim().split(/\s+/).length <= 6)) { destText = tail[1]; fromText = tail[2]; }
    let org = await originNow(), from = null;
    if (fromText && !HERE.test(fromText.trim())) {   // "from Wuse 2 to Jabi": the route starts there
      from = await resolve(fromText, org); if (!from) return `I couldn't find ${fromText}. Try the street and the town.`; org = [from.lat, from.lon];
    }
    if (!org) return noOrigin();
    const g = await resolve(destText, org); if (!g) return `I couldn't find ${destText}. Try the street and the town.`;
    const r = await route([org, [g.lat, g.lon]], mode); if (!r.ok) return r.error;
    const label = (g.short || destText).trim() || destText;
    r.waypoints = [{ lat: org[0], lon: org[1], label: from ? (from.short || fromText) : 'You', kind: 'stop' }, { lat: g.lat, lon: g.lon, label, kind: 'drop' }];
    Object.assign(S, { active: true, route: r, label, mode, delivery: false, progress: null, view: 'full', dest: [[g.lat, g.lon, label]] });
    cmd('route', { route: r, meta: { label, delivery: false } });
    let txt = Navigator.spokenSummary(r, label);
    if (r.traffic && r.traffic.delay_s >= 180) txt += ` Traffic is adding about ${Math.round(r.traffic.delay_s / 60)} minutes.`;
    if (g.distance_km && g.distance_km > 150) txt = `The closest match I found is ${g.display.slice(0, 70)}, ${fmtDistance(g.distance_km * 1000, r.units)} away. ` + txt;
    return txt;
  }
  // several places on one trip ("pick up at Chicken Republic and at Shoprite"): Jarvis visits them in the fastest order
  async function startTrip(places, mode = 'auto', fromText = '') {
    let org = await originNow(), from = null;
    if (fromText && !HERE.test(fromText.trim())) { from = await resolve(fromText, org); if (!from) return `I couldn't find ${fromText}. Try the street and the town.`; org = [from.lat, from.lon]; }
    if (!org) return noOrigin();
    const found = [];
    for (const p of places.slice(0, 6)) {
      const g = await resolve(p, org); if (!g) return `I couldn't find ${p}. Try the street and the town.`;
      found.push({ lat: g.lat, lon: g.lon, label: (g.short || p).trim() || p });
    }
    let order = found.map((_, i) => i + 1);
    try { const [D] = await delivery.matrix([org, ...found.map(f => [f.lat, f.lon])]); order = bestOrder(D); } catch (e) { console.warn('[NAV] trip order', e); }
    const stops = order.map(i => found[i - 1]);
    const r = await route([org, ...stops.map(f => [f.lat, f.lon])], mode); if (!r.ok) return r.error;
    r.waypoints = [{ lat: org[0], lon: org[1], label: from ? (from.short || fromText) : 'You', kind: 'stop' }, ...stops.map(f => ({ ...f, kind: 'drop' }))];
    Object.assign(S, { active: true, route: r, label: stops[0].label, mode, delivery: false, progress: null, view: 'full', dest: stops.map(f => [f.lat, f.lon, f.label]) });
    cmd('route', { route: r, meta: { label: stops[0].label, delivery: false } });
    const first = r.steps.find(x => !x.icon.startsWith('arrive'));
    return `Fastest way: ${stops.map(f => f.label).join(', then ')}. ${fmtDuration(r.time_s)} and ${fmtDistance(r.distance_m, r.units)} in all.` + (first && first.say ? ' ' + first.say : '');
  }

  async function reroute(lat, lon) {
    if (!S.active) return { ok: false, error: "Navigation isn't active." };
    S.pos = { lat, lon, acc: 10.0, ts: Date.now() / 1000, speed: null };
    let r, meta;
    if (S.delivery) { let info; [r, info] = await buildDelivery([lat, lon]); if (r === null) return { ok: false, error: info }; meta = { label: info, delivery: true }; }
    else {
      r = await route([[lat, lon], ...S.dest.map(d => [d[0], d[1]])], S.mode); if (!r.ok) return { ok: false, error: r.error };   // through every stop still ahead
      r.waypoints = [{ lat, lon, label: 'You', kind: 'stop' }, ...S.dest.map(d => ({ lat: d[0], lon: d[1], label: d[2], kind: 'drop' }))]; meta = { label: S.dest[0][2], delivery: false };
    }
    S.route = r; S.progress = null; return { ok: true, route: r, meta };
  }

  // ---- map / voice controls
  async function mapControl(a) {
    a = String(a || '').toLowerCase();
    if (a === 'mini_map' && delivery.hasActive()) {                     // the delivery map under the route card
      S.dashMuted = false;
      if (S.active && S.delivery) { S.view = 'dash'; cmd('view', { mode: 'dash' }); return 'Mini map on.'; }
      const r = await startDash(); return r === 'busy' ? 'Mini map on.' : r === 'on' || r === 'waiting' ? 'Mini map on, with directions to your next stop.' : r;
    }
    if (a === 'show_map' || a === 'mini_map') { const c = origin(); S.view = a === 'show_map' ? 'full' : 'mini'; cmd('view', { mode: S.view, center: c }); return a === 'show_map' ? "Here's the map." : 'Mini map on.'; }
    if (a === 'hide_map') { if (S.delivery || S.view === 'dash') { stop(); return 'Map hidden. Your orders are still on the card.'; } S.view = 'off'; cmd('view', { mode: 'off' }); return 'Map hidden.'; }
    if (a === 'zoom_in' || a === 'zoom_out') { cmd('zoom', { dir: a === 'zoom_in' ? 'in' : 'out' }); return 'Okay.'; }
    if (a === 'overview') { cmd('overview'); return 'Showing the whole route.'; }
    if (a === 'recenter') { cmd('recenter'); return 'Back on you.'; }
    if (['night', 'day', 'auto_theme'].includes(a)) { const v = { night: 'night', day: 'day', auto_theme: 'auto' }[a]; config.set('map_theme', v); cmd('theme', { value: v }); return { night: 'Night map.', day: 'Day map.', auto: 'The map will follow the time of day.' }[v]; }
    if (a === 'mute_voice' || a === 'unmute_voice') { cmd('voice', { on: a === 'unmute_voice' }); return a === 'mute_voice' ? 'Voice guidance off.' : 'Voice guidance on.'; }
    if (a === 'simulate') { if (!S.active) return 'Start a route first, then I can drive it for you.'; cmd('simulate', { on: true }); return 'Simulating the drive.'; }
    if (a === 'stop_simulation') { cmd('simulate', { on: false }); return 'Simulation stopped.'; }
    if (['use_google', 'use_apple', 'use_jarvis_map'].includes(a)) {
      const p = { use_google: 'google', use_apple: 'apple', use_jarvis_map: 'jarvis' }[a], k = keys();
      if (p === 'google' && !k.google) return "The Google map needs a Maps JavaScript API key. Add it in my settings screen under Google Maps key. Until then I'll keep my own map. I can open any route in the Google Maps app; just say open it in Google Maps.";
      if (p === 'apple' && !k.apple) return "The Apple map needs a MapKit JS token. Add it in my settings screen. Until then I'll keep my own map. I can open any route in Apple Maps; just say open it in Apple Maps.";
      config.set('map_provider', p); cmd('provider', { value: p, cfg: cfgOut() });
      return { google: 'Switching to Google Maps.', apple: 'Switching to Apple Maps.', jarvis: 'Using my own map.' }[p];
    }
    if (a.startsWith('avoid_') || a === 'allow_all_roads') {
      if (a === 'allow_all_roads') S.avoid = []; else { const k = a.slice(6); if (!S.avoid.includes(k)) S.avoid.push(k); }
      let txt = 'Okay, ' + (S.avoid.length ? S.avoid.map(x => 'avoiding ' + x).join(' and ') : 'all roads are allowed') + '.';
      if (S.active) { const c = origin(); if (c) { const r = await reroute(c[0], c[1]); if (r.ok) { cmd('route', { route: r.route, meta: { ...r.meta, reroute: true, view: 'keep' } }); txt += ' I found a new route.'; } } }
      return txt;
    }
    if (a === 'gps_on' || a === 'gps_off') { config.set('use_gps', a === 'gps_on'); cmd('cfg', { cfg: { use_gps: a === 'gps_on' } }); return a === 'gps_on' ? 'Using GPS.' : 'GPS off. Tell me where you are when it matters.'; }
    if (a === 'reroute') {
      const c = origin(); if (!S.active || !c) return "I'm not navigating.";
      const r = await reroute(c[0], c[1]); if (!r.ok) return r.error;
      cmd('route', { route: r.route, meta: { ...r.meta, reroute: true, view: 'keep' } }); return 'Recalculated.';
    }
    return "I can't do that with the map.";
  }
  function externalUrl(app, mode, pts) {
    const a = pts[0], z = pts[pts.length - 1], f = x => x.toFixed(6);
    if (app === 'apple') return `https://maps.apple.com/?saddr=${f(a[0])},${f(a[1])}&daddr=${f(z[0])},${f(z[1])}&dirflg=${mode === 'pedestrian' ? 'w' : 'd'}`;
    const tm = { auto: 'driving', bicycle: 'bicycling', pedestrian: 'walking', motor_scooter: 'two-wheeler' }[mode] || 'driving';
    let url = `https://www.google.com/maps/dir/?api=1&origin=${f(a[0])},${f(a[1])}&destination=${f(z[0])},${f(z[1])}&travelmode=${tm}&dir_action=navigate`;
    const mid = pts.slice(1, -1).slice(0, 9);
    if (mid.length) url += '&waypoints=' + encodeURIComponent(mid.map(p => `${f(p[0])},${f(p[1])}`).join('|')).replace(/%2C/g, ',').replace(/%7C/g, '|');
    return url;
  }
  async function openInMaps(app, destination = '') {
    const appName = /apple/i.test(app || '') ? 'apple' : 'google', org = await originNow(); let pts, extra = '';
    if (destination) { if (!org) return noOrigin(); const g = await resolve(destination, org); if (!g) return `I couldn't find ${destination}.`; pts = [org, [g.lat, g.lon]]; }
    else if (S.active && org) pts = [org, ...S.dest.map(d => [d[0], d[1]])];
    else if (delivery.hasActive() && org) pts = [org, ...(await delivery.plan()).stops.map(s => [s.lat, s.lon])];
    else return org ? 'Tell me where to, or start a route first.' : noOrigin();
    if (appName === 'apple' && pts.length > 2) { pts = pts.slice(0, 2); extra = ' Apple Maps takes one stop at a time, so that\'s the first stop.'; }
    openUrl(externalUrl(appName, S.mode, pts));
    return `Opened it in ${appName === 'apple' ? 'Apple' : 'Google'} Maps.${extra}`;
  }
  function stop() {
    if (S.delivery || S.view === 'dash') S.dashMuted = true;            // "stop navigation" during deliveries: no map again until the stack empties
    const was = S.active || S.view === 'dash'; Object.assign(S, { active: false, route: null, delivery: false, progress: null, dest: [], view: 'off', dashPending: false }); cmd('stop');
    return was ? 'Navigation ended.' : "I wasn't navigating.";
  }
  function status() {
    if (!S.active || !S.route) return "I'm not navigating right now.";
    const r = S.route, p = S.progress, now = Date.now() / 1000, u = r.units || 'miles'; let dist, secs, tail = '';
    if (p && now - p.ts < 45) {
      dist = p.remDist; secs = p.remTime; const nxt = p.nextSay || '';
      if (nxt && (p.nextDist || 0) > 0) tail = ` Next, in ${fmtDistance(p.nextDist, u)}, ${nxt.slice(0, 1).toLowerCase() + nxt.slice(1)}`;
    } else { dist = r.distance_m; secs = r.time_s; }
    return `${fmtDuration(secs)} and ${fmtDistance(dist, u)} to ${S.label || 'go'}, arriving about ${clock(now + secs)}.${tail}`;
  }
  async function savePlace(name, address) {
    const org = await originNow(); let entry;
    if (['here', 'this place', 'my location', 'current location', 'where i am'].includes((address || '').trim().toLowerCase())) {
      if (!org) return noOrigin(); const info = (await NAV.reverse(org[0], org[1])) || {};
      entry = { lat: org[0], lon: org[1], address: info.display || 'here', cc: info.country_code || '' };
    } else { const g = await NAV.geocode(address, org); if (!g) return `I couldn't find ${address}.`; entry = { lat: g.lat, lon: g.lon, address: g.display, cc: g.country_code || '' }; }
    const key = name.trim().toLowerCase().replace(/^(my|the)\s+/, ''), places = config.get('places', {}) || {}; places[key] = entry; config.set('places', places);
    return `Saved ${key}.`;
  }
  async function whereAmI() {
    const o = await originNow(); if (!o) return noOrigin();
    const info = await NAV.reverse(o[0], o[1]); if (!info) return "I have your position but can't name the street right now.";
    const weak = (!S.pos || S.pos.acc > 200) ? ' My location is only approximate.' : '';
    return `You're near ${info.short}, ${info.area}.`.replace(', .', '.') + weak;
  }

  // ---- tools
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  T('navigate_to', "Start turn-by-turn navigation to any address, place, business or landmark anywhere in the world. The screen turns into a map. Use for 'navigate to', 'take me to', 'directions to', 'directions from A to B', 'drive to', 'walk to'. Never answer directions with a link or a description of a map: call this.",
    { destination: { type: 'string', description: 'address, place name or saved place like home or work' }, from: { type: 'string', description: "only when they name a different starting point ('from Wuse 2'); otherwise leave out: it starts where they are" }, mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'scooter'], description: 'default driving' },
      stops: { type: 'array', items: { type: 'string' }, description: "other places on the same trip, e.g. a second pickup ('pick up at X and Y': destination X, stops [Y]). Jarvis visits them all in the fastest order." } }, ['destination'],
    a => {
      const mode = { walking: 'pedestrian', cycling: 'bicycle', scooter: 'motor_scooter' }[(a.mode || '').toLowerCase()] || 'auto';
      const more = (Array.isArray(a.stops) ? a.stops : []).map(x => String(x || '').trim()).filter(Boolean);
      return more.length ? startTrip([a.destination, ...more], mode, a.from || '') : start(a.destination, mode, a.from || '');
    });
  T('start_delivery_navigation', 'Start turn-by-turn navigation through every stop of the current delivery stack, in the best order.', {}, [], () => startDelivery());
  T('stop_navigation', 'End turn-by-turn navigation and bring the face back.', {}, [], () => stop());
  T('navigation_status', 'How far, how long, when you arrive, and the next turn, during navigation.', {}, [], () => status());
  T('map_control', 'Control the map screen: show the full map, a mini map, or hide it (face returns); zoom; route overview; night or day theme; mute or unmute voice guidance; simulate driving the route; choose the Google, Apple or Jarvis map; avoid highways, tolls or ferries; turn GPS on or off; find another route.',
    { action: { type: 'string', enum: MAP_ACTIONS } }, ['action'], a => mapControl(a.action));
  T('open_in_maps_app', 'Open the route in the real Google Maps or Apple Maps (app or browser) instead of the Jarvis screen. With no destination it uses the current navigation, or the delivery stack.',
    { app: { type: 'string', enum: ['google', 'apple'] }, destination: { type: 'string' } }, ['app'], a => openInMaps(a.app, a.destination || ''));
  T('save_place', "Remember a named place such as home, work or a warehouse so the driver can say 'navigate home'.",
    { name: { type: 'string' }, address: { type: 'string', description: "street address, or 'here' for the current position" } }, ['name', 'address'], a => savePlace(a.name, a.address));
  T('where_am_i', 'Say where the driver is right now.', {}, [], () => whereAmI());

  // ---- spoken commands that skip the AI (instant, and they work without the network brain)
  const R = {
    stop: /\b(stop|cancel|end|exit|quit|abort|finish)\b.{0,20}\b(navigat\w*|directions|guidance|route|trip)\b|\bnavigation off\b/i,
    fromTo: /^(?:(?:ok(?:ay)?|please|jarvis|hey|can you|could you)[, ]+)*(?:(?:get|give|show) me )?(?:the )?(?:directions?|route|the way|way|navigate|drive|take me)\s+from\s+(.+?)\s+to\s+(.+?)[.!?]*$/i,
    to: /^(?:(?:ok(?:ay)?|please|jarvis|hey|can you|could you)[, ]+)*(?:(?:navigate|drive|route|head|take me|bring me|guide me|walk|cycle|bike|ride)\s+(?:me\s+)?(?:to|towards?)|(?:get|give) me directions to|directions to|how (?:do|can|would) i get to|(?:i )?(?:need|want) (?:to get|directions) to|let'?s drive to|navigate|(?:i (?:need|have) to |let'?s |go )?pick ?up (?:(?:an? |the |my |two |2 |both )?(?:orders?|deliver(?:y|ies)|food|packages?)s? )?(?:at|from|in))\s+(.+?)[.!?]*$/i,
    deliv: /\b(next stop|my (?:next )?(?:stops?|route|deliver\w*|orders?)|the (?:stack|route)|(?:next )?(?:pick.?up|drop.?off|delivery|customer|restaurant)s?)\b/i,
    startDeliv: /^(?:please )?(?:start|begin|resume)\s+(?:the |my )?(?:delivery |route |stack )?(?:navigation|route|run|deliveries)[.!?]*$/i,
    show: /^(?:please )?(?:show|open|bring up|display|pull up|turn on)(?: me)?(?: the| a| your)? (?:map|navigation|map view)[.!?]*$|^map (?:view|mode)[.!?]*$/i,
    mini: /^(?:please )?(?:(?:show|open|give me)(?: me)?(?: the| a)? (?:mini ?map|small map)|(?:minimi[sz]e|shrink)(?: the)? map|map (?:in|to) (?:the )?corner)[.!?]*$/i,
    hide: /^(?:please )?(?:(?:hide|close|dismiss|remove|turn off)(?: the| your)? (?:map|navigation view)|(?:show|bring back|give me back)(?: me)?(?: the| your)? (?:jarvis )?face|face mode)[.!?]*$/i,
    zoom: /^(?:please )?zoom (in|out)(?: (?:a )?(?:bit|little|more))?[.!?]*$|^(?:closer|zoom closer)[.!?]*$|^(?:farther|further out|zoom farther)[.!?]*$/i,
    theme: /\b(night|dark|day|light|auto(?:matic)?)\s+(?:mode|map|theme)\b/i,
    prov: /\b(?:use|switch to|change (?:it )?to|set|go back to|show (?:me )?)\s*(?:the |your )?(google|apple|jarvis|default|my own|own)\s*(?:maps?|map)\b|\b(google|apple) maps? (?:view|screen|style)\b/i,
    ext: /\bopen (?:it |this |the route |the directions |directions )?(?:in|on|with|using) (google|apple) maps?\b/i,
    status: /^(?:how far(?: (?:is it|to go|are we|now))?|how long(?: (?:is it|to go|left|until we arrive))?|how much (?:longer|farther)|when (?:will|do) (?:we|i) (?:get there|arrive)|what'?s my eta|eta|next turn|what'?s the next turn|repeat that|say that again|repeat the (?:direction|instruction)s?)[?.!]*$/i,
    mute: /\b(?:mute|silence)\b.{0,15}\b(?:voice |spoken )?(?:guidance|directions|navigation)\b|\bturn off (?:the )?(?:voice|spoken) (?:guidance|directions)\b|\bguidance off\b/i,
    unmute: /\b(?:unmute|turn on|enable|resume)\b.{0,12}\b(?:voice |spoken )?(?:guidance|directions)\b|\bguidance on\b/i,
    sim: /\b(?:simulate|demo|test)\b.{0,15}\b(?:drive|driving|navigation|route|trip)\b|\bsimulation mode\b/i,
    simOff: /\bstop\b.{0,10}\bsimulat\w+/i,
    where: /^(?:where am i|what'?s my location|where are we)[?.!]*$/i,
    reroute: /\b(?:re-?route|recalculate|find (?:me )?(?:another|a different|an alternate) route)\b/i,
    avoid: /\bavoid(?:ing)? (highways?|freeways?|motorways?|tolls?|ferr(?:y|ies))\b/i,
    allow: /\b(?:allow|use|stop avoiding) (?:all roads|highways?|freeways?|tolls?)\b/i,
    gps: /\b(?:turn|switch) (on|off) (?:the |my )?(?:gps|location)\b/i,
  };
  const modeOf = t => /\b(walk|walking|on foot)\b/i.test(t) ? 'pedestrian' : /\b(bike|cycle|cycling|bicycle)\b/i.test(t) ? 'bicycle' : /\b(scooter|moped)\b/i.test(t) ? 'motor_scooter' : 'auto';
  async function fastpath(text) {
    const t = String(text || '').trim(); if (!t) return null;
    const shown = S.view !== 'off', active = S.active; let m;
    if (R.mute.test(t)) return mapControl('mute_voice');
    if (R.unmute.test(t)) return mapControl('unmute_voice');
    if (R.simOff.test(t) && (active || shown)) return mapControl('stop_simulation');
    if (R.sim.test(t)) return mapControl('simulate');
    if (R.stop.test(t) && (active || shown)) return stop();
    if ((m = R.ext.exec(t))) return openInMaps(m[1]);
    if ((m = R.prov.exec(t))) { const w = (m[1] || m[2] || '').toLowerCase(); return mapControl(w === 'google' ? 'use_google' : w === 'apple' ? 'use_apple' : 'use_jarvis_map'); }
    if (R.startDeliv.test(t)) return startDelivery();
    if ((m = R.fromTo.exec(t))) return start(m[2].trim().replace(/[, ]+(please|thanks|thank you|now|jarvis)$/i, ''), modeOf(t), m[1].trim());
    if ((m = R.to.exec(t))) {
      const dest = m[1].trim().replace(/[, ]+(please|thanks|thank you|now|jarvis)$/i, '').trim();
      if (R.deliv.test(dest) && !/\d/.test(dest)) return delivery.hasActive() ? startDelivery() : 'You have no orders in the stack to navigate to.';
      const parts = dest.split(/\s*(?:,\s*(?:and\s+)?(?:then\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+(?:(?:at|from|to)\s+)?)\s*/i).map(x => x.replace(/^(?:at|from|to)\s+/i, '').trim()).filter(Boolean);
      if (parts.length > 1 && parts.length <= 6) { const r = await startTrip(parts, modeOf(t)); if (!/^I couldn't find/.test(r)) return r; }   // "Shoprite and Chicken Republic"
      return start(dest, modeOf(t));
    }
    if (R.mini.test(t)) return mapControl('mini_map');
    if (R.hide.test(t) && shown) return mapControl('hide_map');
    if (R.show.test(t)) return mapControl('show_map');
    if ((m = R.zoom.exec(t)) && (active || shown)) return mapControl(((m[1] || '').toLowerCase() === 'in' || /^(closer|zoom closer)/i.test(t)) ? 'zoom_in' : 'zoom_out');
    if ((m = R.theme.exec(t)) && (active || shown || /\bmap\b/i.test(t))) { const w = m[1].toLowerCase(); return mapControl(['night', 'dark'].includes(w) ? 'night' : ['day', 'light'].includes(w) ? 'day' : 'auto_theme'); }
    if (R.status.test(t) && active) return status();
    if (R.where.test(t)) return whereAmI();
    if (R.reroute.test(t) && active) return mapControl('reroute');
    if ((m = R.avoid.exec(t))) { const w = m[1].toLowerCase(); return mapControl(w.startsWith('toll') ? 'avoid_tolls' : w.startsWith('ferr') ? 'avoid_ferries' : 'avoid_highways'); }
    if (R.allow.test(t) && S.avoid.length) return mapControl('allow_all_roads');
    if ((m = R.gps.exec(t))) return mapControl(m[1].toLowerCase() === 'on' ? 'gps_on' : 'gps_off');
    return null;
  }
  /** Where he is, for the brain: a fresh look at the phone's GPS (no map needed), named by the street and area. */
  function place() { if (!S.pos || Date.now() / 1000 - S.pos.ts > 300) phoneFix(false); return S.place ? { text: S.place, at: S.placeAt, cc: S.cc } : null; }
  return { state: S, place, startTrip, startDash, endDash, onStopDone: f => { S.onStopDone = f; }, fastpath, position, progress, ended, reroute, config: cfgOut, refreshDelivery, startDelivery, start, origin, stop, status, mapControl, openInMaps, externalUrl };
}
