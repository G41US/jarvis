// tools_home.js - smart home by voice, through Home Assistant (which talks to almost every brand, including Google- and
// Alexa-compatible devices) and Philips Hue (straight to the bridge on your Wi-Fi). "Turn off the bedroom lights",
// "dim the living room to 30 percent", "set the thermostat to 72", "movie scene", "is the garage closed?"
import { httpRaw } from './net.js';

const STOP = new Set(['the', 'my', 'a', 'an', 'light', 'lights', 'lamp', 'lamps', 'bulb', 'bulbs', 'please', 'all', 'in', 'on', 'of', 'room']);
export const words = s => String(s || '').toLowerCase().replace(/[_.]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
/** How well a spoken name matches a device name: 0..1 (all spoken words found = 1). */
export function nameScore(said, name) {
  const a = words(said), b = words(name); if (!a.length || !b.length) return 0;
  const hit = a.filter(w => b.some(x => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x))))).length;
  return hit / a.length - (b.length > a.length ? 0.05 * (b.length - a.length) : 0);
}
export const COLORS = { red: [0, 254], orange: [5000, 254], yellow: [10000, 254], green: [25500, 254], cyan: [35000, 254], blue: [46920, 254], purple: [50000, 254],
  violet: [50000, 254], magenta: [56100, 254], pink: [56100, 160], white: null, 'warm white': null, 'cool white': null };
const kelvin = c => (/warm/.test(c) ? 2700 : /cool|daylight/.test(c) ? 5500 : /white/.test(c) ? 4000 : 0);

export function registerHomeTools(ctx) {
  const { reg, config } = ctx;
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const ha = () => ({ url: String(config.get('ha_url', '') || '').replace(/\/+$/, ''), token: String(config.get('ha_token', '') || '').trim() });
  const hue = () => ({ ip: String(config.get('hue_ip', '') || '').trim(), user: String(config.get('hue_user', '') || '').trim() });
  const haOn = () => !!(ha().url && ha().token), hueOn = () => !!(hue().ip && hue().user);
  const notSet = "You haven't connected a smart home yet. In my settings, under Smart home, add your Home Assistant address and token, or say 'connect my Hue bridge'.";

  async function haReq(method, path, body) {
    const { url, token } = ha();
    const r = await httpRaw(url + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null, timeoutMs: 8000 });
    if (r.status === 401) throw new Error('Home Assistant refused the token');
    if (!r.status) throw new Error("can't reach Home Assistant");
    try { return JSON.parse(r.text || 'null'); } catch { return null; }
  }
  async function hueReq(method, path, body) {
    const { ip, user } = hue();
    const r = await httpRaw(`http://${ip}/api/${user}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null, timeoutMs: 6000 });
    if (!r.status) throw new Error("can't reach the Hue bridge (is the phone on your home Wi-Fi?)");
    return JSON.parse(r.text || 'null');
  }

  /** Everything we can control: [{ sys, id, name, kind, on, extra }] */
  async function devices() {
    const out = [];
    if (haOn()) {
      const st = await haReq('GET', '/api/states') || [];
      for (const e of st) {
        const [dom] = e.entity_id.split('.');
        if (!['light', 'switch', 'fan', 'climate', 'cover', 'lock', 'media_player', 'scene', 'script', 'input_boolean', 'vacuum', 'camera', 'sensor', 'binary_sensor'].includes(dom)) continue;
        if ((dom === 'sensor' || dom === 'binary_sensor') && !/temperature|door|window|motion|garage|humidity/.test(e.entity_id + ' ' + (e.attributes.device_class || ''))) continue;
        out.push({ sys: 'ha', id: e.entity_id, name: e.attributes.friendly_name || e.entity_id.split('.')[1].replace(/_/g, ' '), kind: dom, on: e.state, extra: e.attributes });
      }
    }
    if (hueOn()) {
      const [lights, groups, scenes] = await Promise.all([hueReq('GET', '/lights'), hueReq('GET', '/groups'), hueReq('GET', '/scenes')]);
      for (const [id, g] of Object.entries(groups || {})) if (g.type === 'Room' || g.type === 'Zone') out.push({ sys: 'hue', id: 'g' + id, name: g.name, kind: 'room', on: g.state && g.state.any_on ? 'on' : 'off', extra: g });
      for (const [id, l] of Object.entries(lights || {})) out.push({ sys: 'hue', id: 'l' + id, name: l.name, kind: 'light', on: l.state && l.state.on ? 'on' : 'off', extra: l });
      for (const [id, s] of Object.entries(scenes || {})) out.push({ sys: 'hue', id: 's' + id, name: s.name, kind: 'scene', on: '', extra: s });
    }
    return out;
  }
  function pick(list, said, kinds) {
    const pool = kinds ? list.filter(d => kinds.includes(d.kind)) : list;
    let best = null, score = 0.5;
    for (const d of pool) { let s = nameScore(said, d.name); if (d.kind === 'room') s += 0.02; if (s > score) { score = s; best = d; } }
    return best;
  }

  async function act(d, a) {
    const action = String(a.action || 'on').toLowerCase(), level = a.brightness != null ? Math.max(0, Math.min(100, Number(a.brightness))) : null, color = String(a.color || '').toLowerCase();
    if (d.sys === 'ha') {
      const dom = d.kind, e = { entity_id: d.id };
      if (dom === 'climate') { if (a.temperature == null) return `${d.name} is set to ${d.extra.temperature ?? 'unknown'}, and it's ${d.extra.current_temperature ?? 'unknown'} now.`; await haReq('POST', '/api/services/climate/set_temperature', { ...e, temperature: Number(a.temperature) }); return `${d.name} set to ${a.temperature} degrees.`; }
      if (dom === 'lock') { const svc = /unlock|open/.test(action) ? 'unlock' : 'lock'; await haReq('POST', `/api/services/lock/${svc}`, e); return `${d.name} ${svc}ed.`; }
      if (dom === 'cover') { const svc = /open|up|on/.test(action) ? 'open_cover' : /stop/.test(action) ? 'stop_cover' : 'close_cover'; await haReq('POST', `/api/services/cover/${svc}`, e); return `${d.name}: ${svc.replace('_cover', 'ing').replace('stoping', 'stopped')}.`; }
      if (dom === 'scene' || dom === 'script') { await haReq('POST', `/api/services/${dom}/turn_on`, e); return `${d.name} on.`; }
      if (dom === 'vacuum') { await haReq('POST', `/api/services/vacuum/${/stop|off|dock|home/.test(action) ? 'return_to_base' : 'start'}`, e); return `${d.name}: ${/stop|off|dock|home/.test(action) ? 'heading home' : 'started'}.`; }
      if (dom === 'sensor' || dom === 'binary_sensor') return `${d.name}: ${d.on}${d.extra.unit_of_measurement ? ' ' + d.extra.unit_of_measurement : ''}.`;
      if (action === 'status') return `${d.name} is ${d.on}.`;
      const off = /off/.test(action) && !/on/.test(action), toggle = /toggle/.test(action), svcDom = dom === 'input_boolean' ? 'input_boolean' : dom === 'media_player' ? 'media_player' : dom;
      if (off || toggle) { await haReq('POST', `/api/services/${svcDom}/${toggle ? 'toggle' : 'turn_off'}`, e); return `${d.name} ${toggle ? 'toggled' : 'off'}.`; }
      const data = { ...e };
      if (dom === 'light') {
        if (level != null) data.brightness_pct = level; else if (/dim/.test(action)) data.brightness_step_pct = -25; else if (/bright/.test(action)) data.brightness_step_pct = 25;
        if (color && COLORS[color] !== undefined && COLORS[color]) data.color_name = color; else if (kelvin(color)) data.color_temp_kelvin = kelvin(color);
      }
      await haReq('POST', `/api/services/${svcDom}/turn_on`, data);
      return `${d.name} ${level != null ? 'at ' + level + ' percent' : /dim/.test(action) ? 'dimmed' : /bright/.test(action) ? 'brighter' : 'on'}${color ? ', ' + color : ''}.`;
    }
    // Hue
    if (d.kind === 'scene') { await hueReq('PUT', '/groups/0/action', { scene: d.id.slice(1) }); return `${d.name} scene on.`; }
    const path = d.kind === 'room' ? `/groups/${d.id.slice(1)}/action` : `/lights/${d.id.slice(1)}/state`;
    if (action === 'status') return `${d.name} is ${d.on}.`;
    const body = {};
    if (/toggle/.test(action)) body.on = d.on !== 'on'; else body.on = !(/off/.test(action) && !/on/.test(action));
    if (body.on) {
      if (level != null) body.bri = Math.max(1, Math.round(level * 2.54)); else if (/dim/.test(action)) body.bri_inc = -64; else if (/bright/.test(action)) body.bri_inc = 64;
      if (color && COLORS[color]) { body.hue = COLORS[color][0]; body.sat = COLORS[color][1]; } else if (kelvin(color)) body.ct = Math.round(1e6 / kelvin(color));
    }
    const r = await hueReq('PUT', path, body); if (Array.isArray(r) && r.some(x => x.error)) throw new Error(r.find(x => x.error).error.description);
    return `${d.name} ${body.on === false ? 'off' : level != null ? 'at ' + level + ' percent' : body.bri_inc < 0 ? 'dimmed' : body.bri_inc > 0 ? 'brighter' : 'on'}${body.on && color ? ', ' + color : ''}.`;
  }

  T('smart_home_devices', "List the smart home devices, rooms and scenes Jarvis can control, with their state. room: filter by a word, e.g. 'bedroom'.", { room: { type: 'string' } }, [], async a => {
    if (!haOn() && !hueOn()) return notSet;
    try {
      let l = await devices(); if (a.room) l = l.filter(d => nameScore(a.room, d.name) >= 0.99);
      if (!l.length) return a.room ? `Nothing found for ${a.room}.` : 'No devices found.';
      const main = l.filter(d => ['light', 'room', 'switch', 'fan', 'climate', 'cover', 'lock', 'media_player'].includes(d.kind)).slice(0, 25);
      const scenes = l.filter(d => d.kind === 'scene' || d.kind === 'script').slice(0, 12);
      return main.map(d => `${d.name} (${d.kind === 'room' ? 'room' : d.kind.replace('_', ' ')}): ${d.kind === 'climate' ? (d.extra.current_temperature ?? '') + '°, set ' + (d.extra.temperature ?? '') : d.on}`).join('; ') + (scenes.length ? `. Scenes: ${scenes.map(s => s.name).join(', ')}.` : '.');
    } catch (e) { return `I couldn't reach your smart home: ${e.message}.`; }
  });
  T('smart_home_control', "Control a smart home device or room: lights, plugs, switches, fans, thermostats, blinds/garage, locks, TVs. target: its name or room ('bedroom lights'). action: on, off, toggle, dim, brighten, set, open, close, lock, unlock, status. brightness 0-100, color (red, blue, warm white...), temperature for thermostats. Confirm with the user before unlocking a door or opening a garage.",
    { target: { type: 'string' }, action: { type: 'string' }, brightness: { type: 'number' }, color: { type: 'string' }, temperature: { type: 'number' } }, ['target'], async a => {
      if (!haOn() && !hueOn()) return notSet;
      try {
        const l = await devices();
        const kinds = a.temperature != null ? ['climate'] : /lock/.test(a.action || '') ? ['lock'] : null;
        const d = pick(l, a.target, kinds) || pick(l, a.target, null);
        if (!d) { const near = l.filter(x => ['light', 'room', 'switch', 'climate', 'lock', 'cover', 'fan'].includes(x.kind)).slice(0, 8).map(x => x.name); return `I can't find "${a.target}". I have ${near.join(', ')}.`; }
        return await act(d, a);
      } catch (e) { return `That didn't work: ${e.message}.`; }
    });
  T('smart_home_scene', 'Turn on a smart home scene or routine by name (movie, bedtime, good morning...).', { name: { type: 'string' } }, ['name'], async a => {
    if (!haOn() && !hueOn()) return notSet;
    try { const d = pick(await devices(), a.name, ['scene', 'script']); return d ? await act(d, { action: 'on' }) : `I don't see a scene called ${a.name}.`; }
    catch (e) { return `That didn't work: ${e.message}.`; }
  });
  T('connect_hue', "Connect a Philips Hue bridge: finds it on the Wi-Fi and pairs (the user must press the bridge's round button first).", {}, [], async () => {
    let ip = hue().ip;
    if (!ip) { const r = await httpRaw('https://discovery.meethue.com/', { timeoutMs: 8000 }); try { const j = JSON.parse(r.text); ip = j && j[0] && j[0].internalipaddress; } catch {} }
    if (!ip) return "I can't find a Hue bridge. Make sure the phone is on the same Wi-Fi as the bridge, or type its address in my settings under Smart home.";
    config.set('hue_ip', ip);
    const r = await httpRaw(`http://${ip}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devicetype: 'jarvis#phone' }), timeoutMs: 6000 });
    let j = null; try { j = JSON.parse(r.text); } catch {}
    const ok = Array.isArray(j) && j[0] && j[0].success && j[0].success.username;
    if (ok) { config.set('hue_user', j[0].success.username); return 'Hue bridge connected. Try "turn on the living room".'; }
    if (Array.isArray(j) && j[0] && j[0].error && j[0].error.type === 101) return `Found your Hue bridge at ${ip}. Press the round button on top of it, then say "connect my Hue bridge" again within 30 seconds.`;
    return `I found a bridge at ${ip} but couldn't pair with it.`;
  });
  ctx.home = { devices, configured: () => haOn() || hueOn(), test: async () => { const l = await devices(); return l.length; } };
}
