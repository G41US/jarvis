// Driving helpers: IRS rate by date, directions, distances, shift sums.
import { irsRate, compass, bearing, walkDistance, shiftNumbers } from '../app/src/main/assets/www/local/tools_driving.js';
let fails = 0; const check = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + x)); if (!ok) fails++; };
check('IRS rate: 2025 70¢, 2026 first half 72.5¢, from 1 July 2026 76¢', irsRate(new Date(2025, 5, 1)) === 0.70 && irsRate(new Date(2026, 5, 30)) === 0.725 && irsRate(new Date(2026, 6, 1)) === 0.76);
check('compass', compass(0) === 'north' && compass(90) === 'east' && compass(225) === 'south-west' && compass(-45) === 'north-west');
check('bearing north-east', compass(bearing([33.0, -112.0], [33.01, -111.99])) === 'north-east', bearing([33.0, -112.0], [33.01, -111.99]));
check('walking distances', walkDistance(100) === '350 feet' && walkDistance(5000) === '3.1 miles' && walkDistance(300, false) === '300 metres', [walkDistance(100), walkDistance(5000), walkDistance(300, false)]);
const t0 = new Date(2026, 9, 13, 9, 0).getTime(), t1 = t0 + 4 * 3600000;
const n = shiftNumbers({ start: t0, end: t1, meters: 80 * 1609.344, deliveries: [{ payout: 9.5, delivered_at: (t0 + 3600000) / 1000 }, { payout: 12, delivered_at: (t0 + 7200000) / 1000 }, { payout: 30, delivered_at: (t0 - 3600000) / 1000 }],
  expenses: [{ amount: 40, at: t0 + 1000 }, { amount: 5, at: t1 + 9999999 }] });
check('shift sums: only that shift\'s deliveries and expenses', Math.abs(n.miles - 80) < 1e-9 && n.orders === 2 && n.earned === 21.5 && n.perHour === 21.5 / 4 && Math.abs(n.perMile - 21.5 / 80) < 1e-9 && n.spent === 40, JSON.stringify(n));
check('shift deduction at the October 2026 rate', Math.abs(n.deduction - 80 * 0.76) < 1e-9, n.deduction);
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
