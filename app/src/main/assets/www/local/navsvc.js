// navsvc.js - on-phone navigation service: port of the navigation block in server.py.
// Owns route requests, the delivery-stack route, map/voice controls, and the spoken-command fast path.
import { Navigator, haversineM, resolveUnits, fmtDistance, fmtDuration, clock } from './navlib.js';

const MAP_ACTIONS = ['show_map', 'mini_map', 'hide_map', 'zoom_in', 'zoom_out', 'overview', 'recenter', 'night', 'day', 'auto_theme', 'mute_voice', 'unmute_voice',
  'simulate', 'stop_simulation', 'use_google', 'use_apple', 'use_jarvis_map', 'avoid_highways', 'avoid_tolls', 'avoid_ferries', 'allow_all_roads', 'gps_off', 'gps_on', 'reroute'];
export const NO_ORIGIN = "I don't know where you are yet. Allow location for the app, or tell me 'I'm at' and your address.";

export function createNavService({ reg, config, delivery, broadcast, openUrl, navigator }) {
  const NAV = navigator;
  const S = { active: false, route: null, label: '', mode: 'auto', delivery: false, dest: [], pos: null, synced: null, rv: null, cc: '', progress: null, avoid: [], view: 'off' };
  const cmd = (c, kw = {}) => broadcast('nav:' + JSON.stringify({ cmd: c, ...kw }));
  const keys = () => ({ google: config.get('google_key', '') || '', apple: config.get('apple_token', '') || '' });
  const cfgOut = () => ({ provider: config.get('map_provider', 'jarvis'), theme: config.get('map_theme', 'auto'), units: delivery.units, use_gps: config.get('use_gps', true),
    google_key: keys().google, apple_token: keys().apple });

  function origin() {
    const p = S.pos;
    if (p && Date.now() / 1000 - p.ts < 300 && p.acc <= 200) return [p.lat, p.lon];
    const loc = delivery._getState('loc'); if (loc) return [loc.lat, loc.lon];
    if (p && p.acc <= 5000) return [p.lat, p.lon];
    return null;
  }
  const units = (cc = '') => { const u = resolveUnits((NAV.cfg.units || 'auto'), S.cc || cc); delivery.setUnits(u); return u; };
  const route = (pts, mode) => NAV.route(pts, mode, units(), null, S.avoid);

  async function syncLocation(lat, lon) {
    const last = S.synced; if (last && haversineM(last[0], last[1], lat, lon) < 20) return;
    S.synced = [lat, lon];
    delivery._setState('loc', { lat, lon, label: 'GPS' });
    const rv = S.rv;
    if (!rv || haversineM(rv[0], rv[1], lat, lon) > 4000) {
      const info = await NAV.reverse(lat, lon);
      if (info) { S.rv = [lat, lon]; S.cc = info.country_code || ''; if (info.area) delivery._setState('area', info.area); units(); }
    }
  }
  async function position(p) {
    const lat = parseFloat(p.lat), lon = parseFloat(p.lon); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false };
    const acc = parseFloat(p.acc) || 9999;
    S.pos = { lat, lon, acc, ts: Date.now() / 1000, speed: p.speed };
    if (acc <= 200 && config.get('use_gps', true)) syncLocation(lat, lon).catch(() => {});
    return { ok: true };
  }
  const progress = p => { p.ts = Date.now() / 1000; S.progress = p; return { ok: true }; };
  const ended = () => { if (!S.delivery) { S.active = false; S.route = null; S.progress = null; } return { ok: true }; };

  // ---- delivery-stack navigation
  function mergeStops(stops) {
    const out = [];
    for (const s of stops) {
      const lab = s.kind === 'pickup' ? s.restaurant : s.short_addr, last = out[out.length - 1];
      if (last && last.kind === s.kind && haversineM(last.lat, last.lon, s.lat, s.lon) < 40) { if (!last.label.includes(lab)) last.label += ' and ' + lab; continue; }
      out.push({ lat: s.lat, lon: s.lon, label: lab, kind: s.kind });
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
    const org = origin(); if (!org) return NO_ORIGIN;
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
      if (!delivery.hasActive()) { Object.assign(S, { active: false, route: null, delivery: false, progress: null, view: 'off' }); cmd('stop', { say: 'That was the last stop. Navigation ended.' }); return; }
      const [r, info] = org ? await buildDelivery(org) : [null, NO_ORIGIN];
      if (r === null) { console.warn('[NAV] delivery refresh:', info); return; }
      const wps = r.waypoints;
      Object.assign(S, { route: r, label: info, dest: wps.slice(1).map(w => [w.lat, w.lon, w.label]), progress: null });
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
  async function start(destText, mode = 'auto') {
    const org = origin(); if (!org) return NO_ORIGIN;
    const g = await resolve(destText, org); if (!g) return `I couldn't find ${destText}. Try the street and the town.`;
    const r = await route([org, [g.lat, g.lon]], mode); if (!r.ok) return r.error;
    const label = (g.short || destText).trim() || destText;
    r.waypoints = [{ lat: org[0], lon: org[1], label: 'You', kind: 'stop' }, { lat: g.lat, lon: g.lon, label, kind: 'drop' }];
    Object.assign(S, { active: true, route: r, label, mode, delivery: false, progress: null, view: 'full', dest: [[g.lat, g.lon, label]] });
    cmd('route', { route: r, meta: { label, delivery: false } });
    let txt = Navigator.spokenSummary(r, label);
    if (g.distance_km && g.distance_km > 150) txt = `The closest match I found is ${g.display.slice(0, 70)}, ${fmtDistance(g.distance_km * 1000, r.units)} away. ` + txt;
    return txt;
  }
  async function reroute(lat, lon) {
    if (!S.active) return { ok: false, error: "Navigation isn't active." };
    S.pos = { lat, lon, acc: 10.0, ts: Date.now() / 1000, speed: null };
    let r, meta;
    if (S.delivery) { let info; [r, info] = await buildDelivery([lat, lon]); if (r === null) return { ok: false, error: info }; meta = { label: info, delivery: true }; }
    else {
      const d = S.dest[S.dest.length - 1]; r = await route([[lat, lon], [d[0], d[1]]], S.mode); if (!r.ok) return { ok: false, error: r.error };
      r.waypoints = [{ lat, lon, label: 'You', kind: 'stop' }, { lat: d[0], lon: d[1], label: d[2], kind: 'drop' }]; meta = { label: d[2], delivery: false };
    }
    S.route = r; S.progress = null; return { ok: true, route: r, meta };
  }

  // ---- map / voice controls
  async function mapControl(a) {
    a = String(a || '').toLowerCase();
    if (a === 'show_map' || a === 'mini_map') { const c = origin(); S.view = a === 'show_map' ? 'full' : 'mini'; cmd('view', { mode: S.view, center: c }); return a === 'show_map' ? "Here's the map." : 'Mini map on.'; }
    if (a === 'hide_map') { S.view = 'off'; cmd('view', { mode: 'off' }); return 'Map hidden.'; }
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
    const appName = /apple/i.test(app || '') ? 'apple' : 'google', org = origin(); let pts, extra = '';
    if (destination) { if (!org) return NO_ORIGIN; const g = await resolve(destination, org); if (!g) return `I couldn't find ${destination}.`; pts = [org, [g.lat, g.lon]]; }
    else if (S.active && org) pts = [org, ...S.dest.map(d => [d[0], d[1]])];
    else if (delivery.hasActive() && org) pts = [org, ...(await delivery.plan()).stops.map(s => [s.lat, s.lon])];
    else return org ? 'Tell me where to, or start a route first.' : NO_ORIGIN;
    if (appName === 'apple' && pts.length > 2) { pts = pts.slice(0, 2); extra = ' Apple Maps takes one stop at a time, so that\'s the first stop.'; }
    openUrl(externalUrl(appName, S.mode, pts));
    return `Opened it in ${appName === 'apple' ? 'Apple' : 'Google'} Maps.${extra}`;
  }
  function stop() {
    const was = S.active; Object.assign(S, { active: false, route: null, delivery: false, progress: null, dest: [], view: 'off' }); cmd('stop');
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
    const org = origin(); let entry;
    if (['here', 'this place', 'my location', 'current location', 'where i am'].includes((address || '').trim().toLowerCase())) {
      if (!org) return NO_ORIGIN; const info = (await NAV.reverse(org[0], org[1])) || {};
      entry = { lat: org[0], lon: org[1], address: info.display || 'here', cc: info.country_code || '' };
    } else { const g = await NAV.geocode(address, org); if (!g) return `I couldn't find ${address}.`; entry = { lat: g.lat, lon: g.lon, address: g.display, cc: g.country_code || '' }; }
    const key = name.trim().toLowerCase().replace(/^(my|the)\s+/, ''), places = config.get('places', {}) || {}; places[key] = entry; config.set('places', places);
    return `Saved ${key}.`;
  }
  async function whereAmI() {
    const o = origin(); if (!o) return NO_ORIGIN;
    const info = await NAV.reverse(o[0], o[1]); if (!info) return "I have your position but can't name the street right now.";
    const weak = (!S.pos || S.pos.acc > 200) ? ' My location is only approximate.' : '';
    return `You're near ${info.short}, ${info.area}.`.replace(', .', '.') + weak;
  }

  // ---- tools
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  T('navigate_to', "Start turn-by-turn navigation to any address, place, business or landmark anywhere in the world. The screen turns into a map. Use for 'navigate to', 'take me to', 'directions to', 'drive to', 'walk to'.",
    { destination: { type: 'string', description: 'address, place name or saved place like home or work' }, mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'scooter'], description: 'default driving' } }, ['destination'],
    a => start(a.destination, { walking: 'pedestrian', cycling: 'bicycle', scooter: 'motor_scooter' }[(a.mode || '').toLowerCase()] || 'auto'));
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
    to: /^(?:(?:ok(?:ay)?|please|jarvis|hey|can you|could you)[, ]+)*(?:(?:navigate|drive|route|head|take me|bring me|guide me|walk|cycle|bike|ride)\s+(?:me\s+)?(?:to|towards?)|(?:get|give) me directions to|directions to|(?:i )?(?:need|want) (?:to get|directions) to|let'?s drive to|navigate)\s+(.+?)[.!?]*$/i,
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
    if ((m = R.to.exec(t))) {
      const dest = m[1].trim().replace(/[, ]+(please|thanks|thank you|now|jarvis)$/i, '').trim();
      if (R.deliv.test(dest) && !/\d/.test(dest)) return delivery.hasActive() ? startDelivery() : 'You have no orders in the stack to navigate to.';
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
  return { state: S, fastpath, position, progress, ended, reroute, config: cfgOut, refreshDelivery, startDelivery, start, origin, stop, status, mapControl, openInMaps, externalUrl };
}
