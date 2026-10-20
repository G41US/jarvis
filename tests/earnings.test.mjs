// Earnings page numbers: today / week, per hour and per mile, last 7 days, best hours and areas.
import { stats, summary, lastDays, bestHours, bestAreas, weekStart, dayStart, addDays, hourLabel } from '../app/src/main/assets/www/local/earnings.js';
let fails = 0;
const check = (name, ok, got) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(got))); if (!ok) fails++; };
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;

const now = new Date(2026, 9, 21, 20, 30).getTime();               // Wednesday 21 Oct 2026, 8:30 PM
const at = (dayOffset, h, m = 0) => new Date(2026, 9, 21 + dayOffset, h, m).getTime() / 1000;
const row = (d, h, pay, area = '', restaurant = 'Chipotle', platform = 'DoorDash') => ({ payout: pay, accepted_at: at(d, h) - 1500, delivered_at: at(d, h), area, restaurant, platform });

check('the week starts on Monday', new Date(weekStart(now)).getDay() === 1 && new Date(weekStart(now)).getDate() === 19, new Date(weekStart(now)).toString());
check('addDays keeps midnight', new Date(addDays(dayStart(now), 3)).getHours() === 0);
check('hour labels', hourLabel(18) === '6–7 PM' && hourLabel(11) === '11 AM–12 PM' && hourLabel(23) === '11 PM–12 AM' && hourLabel(0) === '12–1 AM', [hourLabel(18), hourLabel(11), hourLabel(23), hourLabel(0)]);

const log = [
  row(0, 18, 9.5, 'Tempe, AZ'), row(0, 19, 12, 'Tempe, AZ', 'Wingstop', 'Uber Eats'), row(0, 20, 6.5, 'Mesa, AZ'),
  row(-1, 18, 11, 'Tempe, AZ'), row(-1, 12, 5, 'Mesa, AZ'),
  row(-2, 18, 10), row(-9, 18, 40),                                  // last week
];
// today: a 3-hour shift, 30 miles
const trips = [{ start: new Date(2026, 9, 21, 17, 30).getTime(), end: new Date(2026, 9, 21, 20, 30).getTime(), meters: 30 * 1609.344 }];
const t = stats({ log, trips, now, from: dayStart(now), to: addDays(dayStart(now), 1) });
check('today: earned and orders', near(t.earned, 28) && t.orders === 3, t);
check('today: hours and miles from the shift', near(t.hours, 3) && near(t.miles, 30), t);
check('today: per hour and per mile', near(t.perHour, 28 / 3) && near(t.perMile, 28 / 30), t);
check('today: by app', near(t.byPlatform.DoorDash, 16) && near(t.byPlatform['Uber Eats'], 12), t.byPlatform);

const noShift = stats({ log, trips: [], now, from: dayStart(now), to: addDays(dayStart(now), 1) });
check('without a shift, time is first accepted to last delivered', near(noShift.hours, (at(0, 20) - (at(0, 18) - 1500)) / 3600), noShift.hours);
check('without a shift, no miles and no per-mile', noShift.miles === 0 && noShift.perMile === 0, noShift);

const live = { start: new Date(2026, 9, 21, 19, 30).getTime(), meters: 10 * 1609.344 };
const withLive = stats({ log, trips: [], live, now, from: dayStart(now), to: addDays(dayStart(now), 1) });
check('a running shift counts up to now', near(withLive.hours, 1) && near(withLive.miles, 10), withLive);

const half = stats({ log, trips: [{ start: new Date(2026, 9, 20, 23, 0).getTime(), end: new Date(2026, 9, 21, 1, 0).getTime(), meters: 20 * 1609.344 }], now, from: dayStart(now), to: addDays(dayStart(now), 1) });
check('a shift across midnight is split between the days', near(half.hours, 1) && near(half.miles, 10), half);

const s = summary({ log, trips, now });
check('week = Mon-today', near(s.week.earned, 28 + 16 + 10) && s.week.orders === 6, s.week);
check('last week', near(s.lastWeek.earned, 40), s.lastWeek);
check('7 bars, today last', s.days.length === 7 && s.days[6].today && near(s.days[6].earned, 28) && near(s.days[5].earned, 16) && s.days[0].label === 'Thu', s.days.map(d => [d.label, d.earned]));

const h = bestHours({ log, now });
check('best hours: 6-7 PM over 3 days (needs 2+ days)', h.length === 1 && h[0].hour === 18 && near(h[0].avg, (9.5 + 11 + 10 + 40) / 4) && h[0].days === 4, h);
const a = bestAreas({ log, now });
check('best areas by average pay (2+ orders), restaurant when no area', a[0].name === 'Chipotle' && !a[0].area && near(a[0].avg, 25) && a[1].name === 'Tempe, AZ' && near(a[1].avg, (9.5 + 12 + 11) / 3) && a.length === 3, a);
check('empty log is safe', summary({ log: [], now }).today.earned === 0 && bestHours({ log: [], now }).length === 0);
console.log('FAILURES:', fails);
