// Smart home name matching.
import { nameScore, words } from '../app/src/main/assets/www/local/tools_home.js';
let fails = 0; const check = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + x)); if (!ok) fails++; };
const names = ['Bedroom', 'Living room', 'Kitchen ceiling', 'Porch light', 'Bedroom lamp left', 'Thermostat', 'Garage door', 'Master Bedroom'];
const best = said => names.map(n => [n, nameScore(said, n)]).sort((a, b) => b[1] - a[1])[0];
check('"bedroom lights" -> Bedroom (the room)', best('the bedroom lights')[0] === 'Bedroom', best('the bedroom lights'));
check('"living room" -> Living room', best('living room')[0] === 'Living room');
check('"porch" -> Porch light', best('turn on the porch')[0] === 'Porch light', best('turn on the porch'));
check('"kitchen" -> Kitchen ceiling', best('kitchen lights')[0] === 'Kitchen ceiling');
check('"garage" -> Garage door', best('garage')[0] === 'Garage door');
check('"master bedroom" beats plain Bedroom', best('master bedroom')[0] === 'Master Bedroom', best('master bedroom'));
check('unrelated words score low', nameScore('basement', 'Bedroom') < 0.5);
check('filler words ignored', JSON.stringify(words('Turn the Lights in my Bedroom')) === JSON.stringify(['turn', 'bedroom']), JSON.stringify(words('Turn the Lights in my Bedroom')));
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
