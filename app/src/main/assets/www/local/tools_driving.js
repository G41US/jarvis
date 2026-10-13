// tools_driving.js - driving helpers and safety.
//   "I parked here" / "where did I park"                      -> remember_parking / find_my_car
//   "find gas"                                                 -> find_gas (nearest stations, from OpenStreetMap)
//   "start my shift" / "end my shift" / "how's my shift"       -> GPS mileage in the background, earnings, $/hr, $/mile, tax deduction
//   "how many miles this week", "export my mileage log"        -> mileage_log (IRS-style log, CSV or PDF)
//   "emergency" / "I'm safe" / "share my location with Ada"    -> texts your emergency contacts your location, every 5 minutes
import { haversineM } from './navlib.js';

/** IRS business standard mileage rate (US dollars a mile) on a given date. 2026 rose mid-year (Notice 2026-10, then 76¢ from 1 July). */
export function irsRate(ms) {
  const d = new Date(ms), y = d.getFullYear();
  if (y >= 2027) return 0.76;
  if (y === 2026) return d.getMonth() >= 6 ? 0.76 : 0.725;
  if (y === 2025) return 0.70; if (y === 2024) return 0.67; if (y === 2023) return 0.655;
  return 0.655;
}
const MI = 1609.344;
export const compass = deg => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
export function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r), x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return Math.atan2(y, x) / r;
}
export function walkDistance(m, miles = true) {
  if (miles) { const ft = m * 3.28084; return ft < 1000 ? `${Math.max(50, Math.round(ft / 50) * 50)} feet` : `${(m / MI).toFixed(m / MI < 10 ? 1 : 0)} miles`; }
  return m < 1000 ? `${Math.max(20, Math.round(m / 10) * 10)} metres` : `${(m / 1000).toFixed(1)} kilometres`;
}
const hm = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h} hour${h > 1 ? 's' : ''}${m % 60 ? ` ${m % 60} minute${m % 60 > 1 ? 's' : ''}` : ''}` : `${m} minute${m !== 1 ? 's' : ''}`; };

/** Sums for a shift (or any window): trips from the tracker, deliveries from the delivery log, expenses. */
export function shiftNumbers({ start, end, meters, deliveries = [], expenses = [] }) {
  const miles = meters / MI, hours = Math.max(0, (end - start) / 3600000);
  const done = deliveries.filter(r => r.delivered_at * 1000 >= start && r.delivered_at * 1000 <= end);
  const earned = done.reduce((s, r) => s + (Number(r.payout) || 0), 0);
  const spent = expenses.filter(e => e.at >= start && e.at <= end).reduce((s, e) => s + e.amount, 0);
  return { miles, hours, orders: done.length, earned, perHour: hours > 0.1 ? earned / hours : 0, perMile: miles > 0.5 ? earned / miles : 0, deduction: miles * irsRate(start), spent };
}

export function registerDrivingTools(ctx) {
  const { reg, kv, config, delivery, http } = ctx, H = ctx.phoneHelpers;
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const P = () => (typeof window !== 'undefined' && window.AndroidPhone) || null;
  const has = m => !!(P() && typeof P()[m] === 'function');
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };
  const cur = () => config.get('currency', '$') || '$';
  const money = n => `${cur()}${Number(n || 0).toFixed(2)}`;
  const miles = () => (delivery && delivery.units) !== 'km';

  async function here(fresh = true) {
    if (has('freshLocation')) { const l = parse(fresh ? P().freshLocation(7000) : P().lastLocation()); if (l && Number.isFinite(l.lat)) return { lat: l.lat, lon: l.lon, acc: l.acc, age: l.age_s }; }
    const o = ctx.navsvc && ctx.navsvc.origin(); return o ? { lat: o[0], lon: o[1], acc: 50, age: 0 } : null;
  }
  const label = async (lat, lon) => { try { const r = ctx.nav && await ctx.nav.reverse(lat, lon); return r ? (r.short || r.label || '') : ''; } catch { return ''; } };

  // ---------------------------------------------------------------- parking
  T('remember_parking', "Remember where the car is parked (current GPS). minutes: the parking meter's time, to get a reminder 10 minutes before it runs out. note: e.g. 'level 3, row F'.",
    { minutes: { type: 'number' }, note: { type: 'string' } }, [], async a => {
      const p = await here(true); if (!p) return "I can't get your location. Turn on location and try again.";
      const where = await label(p.lat, p.lon);
      kv.set('parking', { lat: p.lat, lon: p.lon, at: Date.now(), note: String(a.note || ''), where });
      let extra = '';
      const m = Number(a.minutes);
      if (m > 0 && H) {
        const at = Date.now() + Math.max(1, m - 10) * 60000;
        H.addItem({ id: 'p' + Date.now().toString(36), at, kind: 'reminder', text: m > 10 ? 'Your parking meter runs out in 10 minutes.' : 'Your parking meter is about to run out.', repeat: '' });
        extra = ` I'll remind you ${m > 10 ? '10 minutes before the meter runs out' : 'when the meter runs out'}.`;
      }
      return `Parking spot saved${where ? ' at ' + where : ''}${a.note ? ', ' + a.note : ''}.${p.acc > 40 ? ' GPS was rough there, so it may be off by about ' + Math.round(p.acc) + ' metres.' : ''}${extra}`;
    });
  T('find_my_car', 'Where the user parked: distance and direction from here, and walking directions if navigate is true.', { navigate: { type: 'boolean' } }, [], async a => {
    const c = kv.get('parking', null); if (!c) return "I don't have a parking spot saved. Next time say 'I parked here'.";
    const ago = hm(Date.now() - c.at), p = await here(true);
    const desc = `${c.where ? 'at ' + c.where : 'where you left it'}${c.note ? ', ' + c.note : ''}, parked ${ago} ago`;
    if (a.navigate) { const r = H.openUrl(`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}&travelmode=walking`, 'walking directions'); return r === 'ok' ? `Walking directions to your car, ${desc}.` : r; }
    if (!p) return `Your car is ${desc}.`;
    const d = haversineM(p.lat, p.lon, c.lat, c.lon);
    if (d < 25) return `You're right by it: your car is ${desc}.`;
    return `Your car is about ${walkDistance(d, miles())} ${compass(bearing([p.lat, p.lon], [c.lat, c.lon]))} of you, ${desc}. Want walking directions?`;
  });

  // ---------------------------------------------------------------- gas
  T('find_gas', 'Nearest gas stations to the user (from OpenStreetMap: name, distance, direction; no live prices). prices: also open GasBuddy for prices.', { prices: { type: 'boolean' } }, [], async a => {
    const p = await here(false) || await here(true); if (!p) return "I can't get your location to find gas.";
    const q = `[out:json][timeout:12];(node["amenity"="fuel"](around:8000,${p.lat},${p.lon});way["amenity"="fuel"](around:8000,${p.lat},${p.lon}););out center 40;`;
    const j = await http('https://overpass-api.de/api/interpreter', { data: q });
    const els = (j && j.elements) || [];
    const st = els.map(e => { const lat = e.lat ?? (e.center && e.center.lat), lon = e.lon ?? (e.center && e.center.lon), t = e.tags || {};
      return { lat, lon, name: t.brand || t.name || 'A gas station', street: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), d: haversineM(p.lat, p.lon, lat, lon) }; })
      .filter(s => Number.isFinite(s.d)).sort((x, y) => x.d - y.d).slice(0, 3);
    if (a.prices) H.openUrl(`https://www.gasbuddy.com/home?search=${p.lat.toFixed(4)}%2C${p.lon.toFixed(4)}`, 'GasBuddy');
    if (!st.length) return a.prices ? "I couldn't find stations nearby, but I've opened GasBuddy." : "I couldn't find gas stations within about five miles.";
    kv.set('last_gas', st);
    return st.map((s, i) => `${i === 0 ? 'Nearest' : i === 1 ? 'Then' : 'And'}: ${s.name}${s.street ? ' on ' + s.street : ''}, ${walkDistance(s.d, miles())} ${compass(bearing([p.lat, p.lon], [s.lat, s.lon]))}`).join('. ') +
      `.${a.prices ? " I've opened GasBuddy for prices." : ' Want directions to the first one, or prices?'}`;
  });

  // ---------------------------------------------------------------- shifts and mileage
  const deliveries = () => ((delivery && delivery._db().log) || []);
  const expenses = () => (ctx.expenses ? ctx.expenses.list() : []);
  T('start_shift', 'Start a driving shift: Jarvis tracks the miles (for the tax log), time, and earnings until end_shift.', {}, [], () => {
    if (!has('shiftStart')) return 'I can only track shifts on the phone.';
    const s = parse(P().shiftStart()) || {}; if (s.error === 'location') { H.call('request', 'location'); return 'I need location access to track your miles. Tap Allow, then say start my shift again.'; }
    const ago = Date.now() - (s.start || Date.now());
    setTimeout(() => window.dispatchEvent(new Event('jv-refresh')), 0);
    return ago > 60000 ? `Your shift is already running: ${hm(ago)} so far.` : "Shift started. I'm tracking your miles; say end my shift when you're done.";
  });
  T('shift_status', "How the current shift is going: time, miles, orders, earnings, per hour and per mile.", {}, [], () => {
    if (!has('shiftStatus')) return 'I can only track shifts on the phone.';
    const s = parse(P().shiftStatus()) || {}; if (!s.active) return "You're not on a shift. Say start my shift.";
    const n = shiftNumbers({ start: s.start, end: Date.now(), meters: s.meters, deliveries: deliveries(), expenses: expenses() });
    return `${hm(Date.now() - s.start)} in, ${n.miles.toFixed(1)} miles, ${n.orders} order${n.orders !== 1 ? 's' : ''}, ${money(n.earned)}${n.earned ? `: ${money(n.perHour)} an hour${n.perMile ? ', ' + money(n.perMile) + ' a mile' : ''}` : ''}.${s.gps ? '' : ' GPS has gone quiet, so miles may be behind.'}`;
  });
  T('end_shift', 'End the driving shift and give the summary: time, miles, orders, earnings, per hour, per mile, tax deduction for the miles.', {}, [], () => {
    if (!has('shiftEnd')) return 'I can only track shifts on the phone.';
    const t = parse(P().shiftEnd()) || {}; if (t.error === 'none') return "You weren't on a shift.";
    const n = shiftNumbers({ start: t.start, end: t.end, meters: t.meters, deliveries: deliveries(), expenses: expenses() });
    kv.set('last_shift', { ...t, ...n }); setTimeout(() => window.dispatchEvent(new Event('jv-refresh')), 0);
    return `Shift done. ${hm(t.end - t.start)}, ${n.miles.toFixed(1)} miles, ${n.orders} order${n.orders !== 1 ? 's' : ''}, ${money(n.earned)} earned` +
      (n.earned ? `, ${money(n.perHour)} an hour${n.perMile ? ' and ' + money(n.perMile) + ' a mile' : ''}` : '') + `. At the IRS rate those miles are worth a ${money(n.deduction)} deduction.` +
      (n.spent ? ` You logged ${money(n.spent)} in expenses.` : '');
  });
  T('mileage_log', "Miles driven on shifts, with the IRS deduction: period today, week, last week, month, last month, year, last year, all. export: 'csv' or 'pdf' for taxes.",
    { period: { type: 'string' }, export: { type: 'string', enum: ['', 'csv', 'pdf'] } }, [], async a => {
      if (!has('trips')) return 'I can only keep the mileage log on the phone.';
      const { periodRange } = await import('./tools_extras.js');
      const [from, to, lbl] = periodRange(a.period || 'week');
      const trips = (parse(P().trips()) || []).filter(t => t.start >= from && t.start < to);
      const live = parse(P().shiftStatus()) || {}; if (live.active && live.start >= from) trips.push({ start: live.start, end: Date.now(), meters: live.meters, live: true });
      if (!trips.length) return `No shifts logged ${lbl}. Say start my shift when you head out.`;
      const mi = trips.reduce((s, t) => s + t.meters / MI, 0), ded = trips.reduce((s, t) => s + (t.meters / MI) * irsRate(t.start), 0), hrs = trips.reduce((s, t) => s + (t.end - t.start), 0);
      let say = `${mi.toFixed(1)} business miles ${lbl} over ${trips.length} shift${trips.length > 1 ? 's' : ''} (${hm(hrs)}), worth about ${money(ded)} at the IRS standard rate.`;
      if (a.export && H.has('docSave')) {
        const d = ms => new Date(ms), day = ms => `${d(ms).getFullYear()}-${String(d(ms).getMonth() + 1).padStart(2, '0')}-${String(d(ms).getDate()).padStart(2, '0')}`, tm = ms => d(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ');
        const rows = trips.map(t => [day(t.start), tm(t.start), tm(t.end), (t.meters / MI).toFixed(1), 'Delivery driving', irsRate(t.start).toFixed(3), ((t.meters / MI) * irsRate(t.start)).toFixed(2)]);
        const body = a.export === 'csv' ? 'date,start,end,miles,purpose,irs_rate,deduction\n' + rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
          : `Business mileage log ${lbl}${config.get('user_name', '') ? ' for ' + config.get('user_name', '') : ''}. Recorded by GPS during shifts.\n\n` + rows.map(r => `${r[0]}  ${r[1]} to ${r[2]}  ${r[3]} miles  ${r[4]}  ($${r[6]} at $${r[5]}/mile)`).join('\n') + `\n\nTotal: ${mi.toFixed(1)} miles, deduction about $${ded.toFixed(2)}.`;
        const r = H.parse(H.call('docSave', a.export, `Mileage log ${lbl}`, body)); if (r) { kv.set('last_doc', r); say += ` Saved "${r.name}" in Documents. Want me to share it?`; }
      }
      return say;
    });

  ctx.shiftSummary = () => {                                          // the readout at the top of the screen
    if (!has('shiftStatus')) return null; const s = parse(P().shiftStatus()) || {}; if (!s.active) return { active: false };
    const n = shiftNumbers({ start: s.start, end: Date.now(), meters: s.meters || 0, deliveries: deliveries(), expenses: [] });
    return { active: true, start: s.start, miles: n.miles, earned: n.earned, currency: cur() };
  };
  const refresh = () => { try { window.dispatchEvent(new Event('jv-refresh')); } catch {} };

  // ---------------------------------------------------------------- safety
  const contacts = () => config.get('emergency_contacts', []) || [];
  T('set_emergency_contact', "Add (or remove) an emergency contact for SOS: a name from the contacts, or a number. Up to five.", { who: { type: 'string' }, remove: { type: 'boolean' } }, ['who'], async a => {
    const list = contacts();
    if (a.remove) { const keep = list.filter(c => !c.name.toLowerCase().includes(String(a.who).toLowerCase())); config.set('emergency_contacts', keep); return keep.length < list.length ? `Removed. ${keep.length} emergency contact${keep.length !== 1 ? 's' : ''} left.` : `${a.who} wasn't on the list.`; }
    let c;
    if (/^[+\d][\d\s().-]{5,}$/.test(String(a.who).trim())) c = { name: String(a.who).trim(), number: String(a.who).replace(/[^\d+]/g, '') };
    else { const r = H.call('findContact', String(a.who)); const n = H.needed(r); if (n) return n; const l = H.parse(r) || []; if (!l.length) return `I don't see ${a.who} in your contacts. What's their number?`; c = { name: l[0].name, number: l[0].number }; }
    if (list.some(x => x.number === c.number)) return `${c.name} is already an emergency contact.`;
    if (list.length >= 5) return 'You already have five emergency contacts. Remove one first.';
    config.set('emergency_contacts', [...list, c]);
    const perm = H.has('status') && !(H.parse(H.call('status')) || {}).sms ? (H.call('request', 'sms'), ' Allow Jarvis to send texts so SOS works hands-free.') : '';
    return `${c.name} is now an emergency contact.${perm}`;
  });
  T('emergency', "SOS: the user is in danger or needs help. Texts their emergency contacts their location now and every 5 minutes, until im_safe. message: what's happening, if they said. Then ask whether to call 911.",
    { message: { type: 'string' } }, [], async a => {
      const list = contacts();
      if (!list.length) { H.call('dialEmergency', '911'); return "You haven't set emergency contacts yet, so I've opened the dialer with 911. Tap call if you need it. Later, say 'add Ada as my emergency contact'."; }
      if (!has('sosStart')) return 'SOS works on the phone only.';
      const r = parse(P().sosStart(JSON.stringify(list), String(config.get('user_name', '') || ''), String(a.message || ''))) || {};
      if (r.error === 'sms') {   // can't text by himself: open a message to all of them with the location, ready to send
        H.call('request', 'sms');
        const place = has('placeText') ? P().placeText() : '';
        const o = H.openUrl(`smsto:${list.map(c => c.number).join(';')}?body=${encodeURIComponent('EMERGENCY: I need help. ' + (a.message ? a.message + ' ' : '') + 'Location: ' + place)}`, 'the SOS message');
        return (window.JARVIS_IOS ? `iPhone makes you tap Send yourself: the SOS message is open with your location, to ${list.map(c => c.name).join(' and ')}.` : `I can't send texts by myself yet, so the SOS message is open with your location: tap send.`) + `${o === 'ok' ? '' : ' ' + o} Say "call 911" if you need emergency services.`;
      }
      if (r.error) return "The SOS didn't go out. Call 911 if you're in danger.";
      refresh();
      return `SOS sent to ${list.map(c => c.name).join(' and ')} with your location. I'll send updates every five minutes until you say "I'm safe". Do you want me to call 911?`;
    });
  T('im_safe', "The user is safe: stop the SOS updates and tell the emergency contacts.", {}, [], () => {
    if (!has('sosStop')) return "Good. Glad you're safe.";
    const r = parse(P().sosStop('')) || {}; refresh();
    return r.was_active ? `Good. I've told ${contacts().map(c => c.name).join(' and ') || 'your contacts'} you're safe and stopped the updates.` : "Good. There was no SOS running.";
  });
  T('share_location', "Text someone the user's current location (a map link). who: a contact name or number.", { who: { type: 'string' } }, ['who'], async a => {
    const r = H.call('findContact', String(a.who)); let num = /^[+\d][\d\s().-]{5,}$/.test(String(a.who).trim()) ? String(a.who).replace(/[^\d+]/g, '') : '', name = a.who;
    if (!num) { const n = H.needed(r); if (n) return n; const l = H.parse(r) || []; if (!l.length) return `I don't see ${a.who} in your contacts.`; num = l[0].number; name = l[0].name; }
    if (has('shareLocation')) { const n = P().shareLocation(JSON.stringify([num]), "Here's where I am"); if (n > 0) return `Sent ${name} your location.`; }
    const place = has('placeText') ? P().placeText() : ''; const o = H.openUrl(`smsto:${num}?body=${encodeURIComponent("Here's where I am: " + place)}`, 'the message');
    return o === 'ok' ? `Your location is in a message to ${name}. Tap send.` : o;
  });
}
