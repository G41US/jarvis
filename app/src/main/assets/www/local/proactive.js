// proactive.js - Jarvis speaks up on his own, when it matters:
//   morning briefing at a set time (a real alarm, so it comes even if he was closed)
//   severe weather alerts for where you are (US National Weather Service), or storms coming in the next hours elsewhere
//   birthdays from your contacts, in the morning
//   "time to leave" for calendar events that have a place (travel time from where you are)
//   battery low while you're driving, and a break nudge every three hours on a shift
// Each one can be switched off by voice ("turn off weather alerts") or in Settings.

export const DEFAULTS = { briefing: '', weather: true, birthdays: true, leave: true, battery: true, breaks: true };
const DAY = 86400000;
const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ');

/** Birthdays today and in the next `days` days, soonest first. list: [{name, md:'MM-DD', year}] */
export function upcomingBirthdays(list, now = new Date(), days = 7) {
  const out = [];
  for (const b of list || []) {
    const [m, d] = String(b.md).split('-').map(Number); if (!m || !d) continue;
    let when = new Date(now.getFullYear(), m - 1, d); const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (when < t0) when = new Date(now.getFullYear() + 1, m - 1, d);
    const inDays = Math.round((when - t0) / DAY);
    if (inDays <= days) out.push({ ...b, inDays, age: b.year ? when.getFullYear() - b.year : 0 });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

/** When to say "time to leave": start - travel - margin (10 min), never before it's useful. */
export const leaveAt = (startMs, travelS, marginMin = 10) => startMs - travelS * 1000 - marginMin * 60000;

/** NWS alert -> one or two spoken sentences. */
export function sayAlert(p) {
  const until = p.ends || p.expires ? ` until ${clock(Date.parse(p.ends || p.expires))}` : '';
  const parts = String(p.instruction || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!])\s+/);   // up to two short sentences of what to do
  let instr = parts[0] || ''; if (parts[1] && (instr + ' ' + parts[1]).length <= 160) instr += ' ' + parts[1];
  return `Weather alert: ${p.event}${until}.${instr ? ' ' + instr : ''}`;
}

export function createProactive(ctx) {
  const { kv, config, broadcast, http, log = () => {} } = ctx;
  const P = () => (typeof window !== 'undefined' && window.AndroidPhone) || null;
  const B = () => (typeof window !== 'undefined' && window.AndroidBridge) || null;
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };
  const opt = k => { const v = config.get('pa_' + k, null); return v === null || v === undefined ? DEFAULTS[k] : v; };
  const seen = (key, ttl = DAY) => { const m = kv.get('pa_seen', {}), now = Date.now(); for (const k of Object.keys(m)) if (now - m[k] > 7 * DAY) delete m[k]; if (m[key] && now - m[key] < ttl) return true; m[key] = now; kv.set('pa_seen', m); return false; };
  const say = text => { log('[PROACTIVE]', text); broadcast('proactive:' + text); };
  const where = () => { const l = P() && P().lastLocation ? parse(P().lastLocation()) : null; if (l && Number.isFinite(l.lat)) return [l.lat, l.lon]; const o = ctx.navsvc && ctx.navsvc.origin(); return o || null; };
  const last = {};
  const every = (name, ms) => { const now = Date.now(); if (last[name] && now - last[name] < ms) return false; last[name] = now; return true; };

  // ---- morning briefing: a daily native alarm (rings even if Jarvis was closed; the page then speaks the briefing)
  function scheduleBriefing() {
    const t = String(opt('briefing') || ''), p = P();
    if (!p || !p.reminderAdd) return;
    try { p.reminderCancel('briefing'); } catch {}
    const m = /^(\d{1,2}):(\d{2})$/.exec(t); if (!m) return;
    const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    p.reminderAdd(JSON.stringify({ id: 'briefing', at: d.getTime(), kind: 'briefing', text: 'Morning briefing', repeat: 'daily' }));
  }

  async function weather() {
    if (!opt('weather')) return;
    const w = where(); if (!w || !every('weather', 20 * 60000)) return;            // the 20-minute pace starts with the first real check
    const j = await http('https://api.weather.gov/alerts/active', { point: `${w[0].toFixed(4)},${w[1].toFixed(4)}` });
    if (j && Array.isArray(j.features)) {
      for (const f of j.features) {
        const p = f.properties || {}; if (!/Severe|Extreme/.test(p.severity || '') && !/Warning/.test(p.event || '')) continue;
        if (seen('nws:' + (p.id || f.id), 2 * DAY)) continue;
        say(sayAlert(p)); return;
      }
      return;
    }
    // outside the US: thunderstorms or heavy rain in the next three hours (Open-Meteo), once a day
    const fc = await http('https://api.open-meteo.com/v1/forecast', { latitude: w[0], longitude: w[1], hourly: 'weather_code,precipitation_probability,precipitation', forecast_hours: 4, timezone: 'auto' });
    const h = fc && fc.hourly; if (!h || !h.time) return;
    for (let i = 1; i < h.time.length; i++) {
      const storm = h.weather_code[i] >= 95, heavy = (h.precipitation_probability[i] || 0) >= 80 && (h.precipitation[i] || 0) >= 3;
      if ((storm || heavy) && !seen('wx:' + ymd(), DAY)) { say(`Heads up: ${storm ? 'thunderstorms' : 'heavy rain'} likely around ${clock(Date.parse(h.time[i]))}.`); return; }
    }
  }

  function birthdays() {
    if (!opt('birthdays') || new Date().getHours() < 8 || !every('birthdays', 60 * 60000)) return;
    const p = P(); if (!p || !p.birthdays) return;
    const r = p.birthdays(); if (/^need-/.test(r)) return;
    const today = upcomingBirthdays(parse(r) || [], new Date(), 0);
    if (!today.length || seen('bday:' + ymd(), DAY)) return;
    const one = b => `${b.name}${b.age ? `, turning ${b.age}` : ''}`;
    say(today.length === 1 ? `It's ${today[0].name}'s birthday today${today[0].age ? ` (${today[0].age})` : ''}. Want me to send a message?`
      : `Birthdays today: ${today.slice(0, -1).map(one).join('; ')} and ${one(today[today.length - 1])}. Want me to send them a message?`);
  }

  async function leave() {
    if (!opt('leave')) return;
    const p = P(); if (!p || !p.calendarEvents) return;
    const st = parse(p.status && p.status()) || {}; if (!st.calendar) return;
    const w = where(); if (!w || !every('leave', 5 * 60000)) return;
    const now = Date.now(), evs = parse(p.calendarEvents(now, now + 3 * 3600000)) || [];
    for (const e of evs) {
      if (e.allDay || !e.location || e.begin <= now || seen('leave:' + e.title + e.begin, DAY)) continue;
      const g = ctx.nav && await ctx.nav.geocode(e.location, w); if (!g) continue;
      const r = ctx.nav && await ctx.nav.route([w, [g.lat, g.lon]], 'auto', 'km'); if (!r || !r.ok) continue;
      const go = leaveAt(e.begin, r.time_s);
      if (now >= go) { say(`Time to leave for ${e.title}: it's about ${Math.max(1, Math.round(r.time_s / 60))} minutes away and starts at ${clock(e.begin)}. Want directions?`); return; }
      const m = kv.get('pa_seen', {}); delete m['leave:' + e.title + e.begin]; kv.set('pa_seen', m);   // not yet: check again later
    }
  }

  function battery() {
    if (!opt('battery') || !every('battery', 5 * 60000)) return;
    const b = B() && B().battery ? parse(B().battery()) : null; if (!b || b.charging || !(b.level <= 20)) return;
    const driving = (ctx.navsvc && ctx.navsvc.state && ctx.navsvc.state.active) || (P() && P().shiftStatus && (parse(P().shiftStatus()) || {}).active);
    if (!driving || seen('batt:' + (b.level <= 10 ? 10 : 20), 3 * 3600000)) return;
    say(`Battery at ${b.level} percent. Plug in if you can${b.level <= 10 ? ', or I may go quiet during your route' : ''}.`);
  }

  function breaks() {
    if (!opt('breaks') || !every('breaks', 10 * 60000)) return;
    const s = P() && P().shiftStatus ? parse(P().shiftStatus()) : null; if (!s || !s.active) return;
    const hrs = Math.floor((Date.now() - s.start) / 3600000); if (hrs < 3 || hrs % 3 !== 0) return;
    if (seen('break:' + s.start + ':' + hrs, DAY)) return;
    say(`You've been on the road ${hrs} hours. Good moment for a short break and some water.`);
  }

  async function tick() {
    for (const f of [weather, birthdays, leave, battery, breaks]) { try { await f(); } catch (e) { log('[PROACTIVE]', f.name, e && e.message); } }
  }

  let iv = null;
  return {
    start() { scheduleBriefing(); if (!iv) { iv = setInterval(tick, 60000); setTimeout(tick, 15000); } },
    stop() { clearInterval(iv); iv = null; },
    tick, scheduleBriefing, opt,
    resetPacing() { for (const k of Object.keys(last)) delete last[k]; kv.set('pa_seen', {}); },   // tests
    set(name, value) { config.set('pa_' + name, value); if (name === 'briefing') scheduleBriefing(); },
    status() { return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, opt(k)])); },
  };
}

export function registerProactiveTools(ctx, pro) {
  const { reg } = ctx, T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };
  T('set_proactive', "Turn Jarvis's own alerts on or off, or set the morning briefing time. alert: briefing (time 'HH:MM' 24-hour, or off), weather, birthdays, leave (time to leave for calendar events), battery, breaks (on shifts).",
    { alert: { type: 'string', enum: ['briefing', 'weather', 'birthdays', 'leave', 'battery', 'breaks'] }, on: { type: 'boolean' }, time: { type: 'string' } }, ['alert'], a => {
      if (a.alert === 'briefing') {
        if (a.on === false || /off|none/i.test(a.time || '')) { pro.set('briefing', ''); return 'Morning briefing turned off.'; }
        const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(a.time || '7:00')); let h = +m[1]; const mi = m[2] ? +m[2] : 0; if (/pm/i.test(m[3] || '') && h < 12) h += 12; if (/am/i.test(m[3] || '') && h === 12) h = 0;
        const t = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; pro.set('briefing', t);
        return `I'll give you the briefing every morning at ${new Date(2000, 0, 1, h, mi).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ')}.`;
      }
      pro.set(a.alert, a.on !== false);
      const what = { weather: 'severe weather alerts', birthdays: 'birthday reminders', leave: '"time to leave" alerts for your calendar', battery: 'low battery warnings while driving', breaks: 'break reminders on long shifts' }[a.alert];
      return `${a.on !== false ? 'On' : 'Off'}: ${what}.`;
    });
  T('proactive_status', "Which of Jarvis's own alerts are on.", {}, [], () => {
    const s = pro.status();
    return `Morning briefing ${s.briefing ? 'at ' + s.briefing : 'off'}. Weather alerts ${s.weather ? 'on' : 'off'}, birthdays ${s.birthdays ? 'on' : 'off'}, time to leave ${s.leave ? 'on' : 'off'}, battery ${s.battery ? 'on' : 'off'}, breaks ${s.breaks ? 'on' : 'off'}.`;
  });
  T('birthdays', 'Upcoming birthdays from the phone contacts. days: how far ahead (default 30).', { days: { type: 'integer' } }, [], a => {
    const p = window.AndroidPhone; if (!p || !p.birthdays) return 'I can only read birthdays on the phone.';
    const r = p.birthdays(); if (r === 'need-contacts') { p.request('contacts'); return 'I need access to your contacts for birthdays. Tap Allow, then ask again.'; }
    const l = upcomingBirthdays(parse(r) || [], new Date(), Number(a.days) || 30);
    if (!l.length) return `No birthdays in the next ${Number(a.days) || 30} days.`;
    return l.slice(0, 8).map(b => `${b.name}${b.age ? ' turns ' + b.age : ''} ${b.inDays === 0 ? 'today' : b.inDays === 1 ? 'tomorrow' : 'in ' + b.inDays + ' days'}`).join('; ') + '.';
  });
}
