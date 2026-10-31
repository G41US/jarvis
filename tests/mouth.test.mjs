// node tests/mouth.test.mjs - the mouth follows speech loudness: shut when quiet, open on loud sounds, smooth in between
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../app/src/main/assets/www/local/shim.js', import.meta.url), 'utf8');
const mouthFollower = new Function('return ' + src.slice(src.indexOf('function mouthFollower'), src.indexOf('\n}\n', src.indexOf('function mouthFollower')) + 2))();
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + x)); if (!c) fails++; };
let raw = -1; const f = mouthFollower(() => raw);
check('no measurement: -1 (the page keeps its own rhythm)', f() === -1);
raw = 0; let v; for (let i = 0; i < 20; i++) v = f(); check('silence: mouth shut', v < 0.02, v);
raw = 0.2; for (let i = 0; i < 4; i++) v = f(); check('a loud vowel opens it within a few frames', v > 0.8, v);
raw = 0.01; const a = f(), b = f(); check('then it closes, a little slower than it opened', a > b && a > 0.3 && b < a, [a, b]);
raw = 0.05; for (let i = 0; i < 300; i++) v = f(); check('a quieter voice still moves it (measured against his own loudest)', v > 0.6, v);
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
