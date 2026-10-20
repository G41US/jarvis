// earnings.js - the numbers behind the Earnings page and driving mode: what you made today and this week, per hour and per mile,
// the last 7 days, and the hours and areas that pay you best (from your own delivery log). Pure functions, no phone needed.
//   log rows   {payout, accepted_at, delivered_at (seconds), platform, restaurant, area?}
//   trips      [{start, end, meters}] shifts from the GPS tracker (ms); live: the running shift {start, meters} or null
export const MI = 1609.344;
const DAY = 86400000;

export function dayStart(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
/** Monday 00:00 of the week (delivery apps pay Monday to Sunday). */
export function weekStart(ms) { const d0 = dayStart(ms), wd = (new Date(d0).getDay() + 6) % 7; return addDays(d0, -wd); }
/** Calendar days, not 24-hour steps (a day with a clock change is 23 or 25 hours). */
export function addDays(ms, n) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); }

const inWin = (r, from, to) => { const t = r.delivered_at * 1000; return t >= from && t < to; };
const shifts = (trips, live, now) => [...(trips || []), ...(live && live.start ? [{ start: live.start, end: now, meters: live.meters || 0 }] : [])]
  .filter(t => t && t.end > t.start);

/** Totals for a window [from, to). Time and miles come from shifts when there are any, else from the orders' own times. */
export function stats({ log = [], trips = [], live = null, now = Date.now(), from, to }) {
  to = Math.min(to, now);
  const rows = log.filter(r => inWin(r, from, to));
  const earned = rows.reduce((s, r) => s + (Number(r.payout) || 0), 0);
  let ms = 0, meters = 0;
  for (const t of shifts(trips, live, now)) {
    const o = Math.max(0, Math.min(t.end, to) - Math.max(t.start, from)); if (!o) continue;
    ms += o; meters += (t.meters || 0) * (o / (t.end - t.start));
  }
  if (!ms && rows.length) {                       // no shift tracked: first accepted to last delivered, day by day
    const byDay = {};
    for (const r of rows) { const k = dayStart(r.delivered_at * 1000); const d = byDay[k] || (byDay[k] = [Infinity, 0]);
      d[0] = Math.min(d[0], (r.accepted_at || r.delivered_at) * 1000); d[1] = Math.max(d[1], r.delivered_at * 1000); }
    for (const [a, b] of Object.values(byDay)) ms += Math.max(0, b - a);
  }
  const hours = ms / 3600000, miles = meters / MI;
  const byPlatform = {};
  for (const r of rows) byPlatform[r.platform || 'Other'] = (byPlatform[r.platform || 'Other'] || 0) + (Number(r.payout) || 0);
  return { earned, orders: rows.length, hours, miles, perHour: hours >= 0.25 && earned ? earned / hours : 0, perMile: miles >= 1 && earned ? earned / miles : 0, byPlatform };
}

/** One bar per day for the last n days, oldest first. */
export function lastDays({ log = [], now = Date.now(), n = 7 }) {
  const today = dayStart(now), out = [];
  for (let i = n - 1; i >= 0; i--) {
    const from = addDays(today, -i), to = addDays(from, 1), rows = log.filter(r => inWin(r, from, to));
    out.push({ from, label: new Date(from).toLocaleDateString('en-US', { weekday: 'short' }), today: i === 0,
      earned: rows.reduce((s, r) => s + (Number(r.payout) || 0), 0), orders: rows.length });
  }
  return out;
}

export const hourLabel = h => { const f = x => `${x % 12 || 12}`, ap = x => (x % 24 < 12 ? 'AM' : 'PM');
  return ap(h) === ap(h + 1) ? `${f(h)}–${f(h + 1)} ${ap(h)}` : `${f(h)} ${ap(h)}–${f(h + 1)} ${ap(h + 1)}`; };

/** The hours of the day that pay best: average earned in that hour, over the days you worked it (last 8 weeks, at least 2 days). */
export function bestHours({ log = [], now = Date.now(), weeks = 8, top = 3 }) {
  const from = now - weeks * 7 * DAY, by = {};
  for (const r of log) {
    const t = r.delivered_at * 1000; if (t < from || t > now) continue;
    const h = new Date(t).getHours(), b = by[h] || (by[h] = { total: 0, days: new Set(), n: 0 });
    b.total += Number(r.payout) || 0; b.days.add(dayStart(t)); b.n++;
  }
  return Object.entries(by).filter(([, b]) => b.days.size >= 2)
    .map(([h, b]) => ({ hour: +h, label: hourLabel(+h), avg: b.total / b.days.size, days: b.days.size, orders: b.n }))
    .sort((a, b) => b.avg - a.avg || b.days - a.days).slice(0, top);
}

/** Where the best-paying orders go (the drop-off area; the restaurant when the area isn't known). At least 2 orders. */
export function bestAreas({ log = [], now = Date.now(), weeks = 8, top = 3 }) {
  const from = now - weeks * 7 * DAY, by = {};
  for (const r of log) {
    if (r.delivered_at * 1000 < from) continue;
    const name = String(r.area || r.restaurant || '').trim(); if (!name) continue;
    const b = by[name] || (by[name] = { total: 0, n: 0, byArea: !!r.area }); b.total += Number(r.payout) || 0; b.n++;
  }
  return Object.entries(by).filter(([, b]) => b.n >= 2).map(([name, b]) => ({ name, avg: b.total / b.n, orders: b.n, total: b.total, area: b.byArea }))
    .sort((a, b) => b.avg - a.avg || b.orders - a.orders).slice(0, top);
}

/** Everything the page shows. */
export function summary({ log = [], trips = [], live = null, now = Date.now() }) {
  const t0 = dayStart(now), w0 = weekStart(now);
  return {
    today: stats({ log, trips, live, now, from: t0, to: addDays(t0, 1) }),
    week: stats({ log, trips, live, now, from: w0, to: addDays(w0, 7) }),
    lastWeek: stats({ log, trips, live, now, from: addDays(w0, -7), to: w0 }),
    days: lastDays({ log, now }), hours: bestHours({ log, now }), areas: bestAreas({ log, now }), total: log.length,
  };
}
