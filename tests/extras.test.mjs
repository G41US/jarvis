// Camera extras and expenses: what QR codes say, receipt categories, date ranges.
import { describeQr, guessCategory, periodRange } from '../app/src/main/assets/www/local/tools_extras.js';
let fails = 0; const check = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + x)); if (!ok) fails++; };
let d = describeQr('https://www.example.com/menu?table=4'); check('QR link', d.kind === 'link' && d.say.includes('example.com'), JSON.stringify(d));
d = describeQr('WIFI:T:WPA;S:Cafe Guest;P:sun' + String.fromCharCode(92) + ';shine42;;'); check('QR Wi-Fi with escaped ;', d.kind === 'wifi' && d.ssid === 'Cafe Guest' && d.password === 'sun;shine42', JSON.stringify(d));
d = describeQr('WIFI:S:Lobby;T:nopass;P:;;'); check('QR open Wi-Fi', d.kind === 'wifi' && d.say.includes('no password'), JSON.stringify(d));
d = describeQr('tel:+15551234567'); check('QR phone', d.kind === 'phone' && d.say.includes('+15551234567'));
d = describeQr('BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL;TYPE=cell:+1 555 0100\nEND:VCARD'); check('QR contact card', d.kind === 'contact' && d.say.includes('Ada Lovelace') && d.say.includes('555 0100'), d.say);
d = describeQr('Table 12 - order at the counter'); check('QR text', d.kind === 'text' && d.say === 'It says: Table 12 - order at the counter');
check('categories', guessCategory('Shell gas station') === 'fuel' && guessCategory('parking meter') === 'parking' && guessCategory('E-ZPass') === 'tolls' && guessCategory('phone mount') === 'supplies' && guessCategory('random') === 'other');
const now = new Date(2026, 9, 14, 15, 0);   // Wednesday 14 Oct 2026
let [a, b, l] = periodRange('week', now); check('this week starts Monday', new Date(a).getDate() === 12 && l === 'this week', new Date(a));
[a, b] = periodRange('last week', now); check('last week', new Date(a).getDate() === 5 && new Date(b).getDate() === 12);
[a, b] = periodRange('month', now); check('this month', new Date(a).getDate() === 1 && new Date(a).getMonth() === 9);
[a, b] = periodRange('today', now); check('today', b - a === 86400000 && new Date(a).getDate() === 14);
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
