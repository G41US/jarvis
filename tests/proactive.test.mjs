// Proactive alerts: birthdays, time to leave, weather alert wording.
import { upcomingBirthdays, leaveAt, sayAlert } from '../app/src/main/assets/www/local/proactive.js';
let fails = 0; const check = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + x)); if (!ok) fails++; };
const now = new Date(2026, 11, 30, 9, 0);   // 30 Dec 2026
const b = upcomingBirthdays([{ name: 'Ada', md: '12-30', year: 1990 }, { name: 'Tunde', md: '01-02', year: 0 }, { name: 'Zara', md: '06-01', year: 2000 }, { name: 'Old', md: '12-01', year: 1980 }], now, 7);
check('today first, with age; next year wraps; far ones left out', b.length === 2 && b[0].name === 'Ada' && b[0].inDays === 0 && b[0].age === 36 && b[1].name === 'Tunde' && b[1].inDays === 3 && b[1].age === 0, JSON.stringify(b));
check('only today', upcomingBirthdays([{ name: 'Ada', md: '12-30' }, { name: 'Tunde', md: '12-31' }], now, 0).map(x => x.name).join() === 'Ada');
const start = new Date(2026, 9, 13, 15, 0).getTime();
check('leave = start - travel - 10 minutes', leaveAt(start, 25 * 60) === start - 35 * 60000);
const s = sayAlert({ event: 'Tornado Warning', ends: '2026-10-13T18:45:00-05:00', instruction: 'TAKE COVER NOW! Move to a basement or an interior room. Avoid windows.' });
check('weather alert spoken: event, until, first instruction', /^Weather alert: Tornado Warning until \d{1,2}:45 [AP]M\. TAKE COVER NOW! Move to a basement or an interior room\.$/.test(s), s);
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
