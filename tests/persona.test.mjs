// Characters ("be Ultron"): the tools, what the voice is given, and the instructions while in character.
import assert from 'node:assert/strict';
import { createPersona } from '../app/src/main/assets/www/local/persona.js';
const store = new Map(), cfgStore = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) };
const tools = {}, reg = { add: (n, d, p, r, f) => { tools[n] = f; } };
let changed = 0;
const p = createPersona({ reg, cfgStore, onChange: () => changed++ });
assert.ok(tools.become && tools.stop_being);
assert.equal(p.prompt(), ''); assert.equal(p.deliver('Hello.'), 'Hello.');
const said = tools.become({ who: 'Ultron', gender: 'male', voice: 'troy', pitch: 0.4, speed: 0.9, delivery: 'menacing calm!', accent: 'American', style: 'Grandiose, sardonic.' });
assert.match(said, /Ultron/);
const r = p.get();
assert.equal(r.voice, 'troy'); assert.equal(r.pitch, 0.75);                 // kept in a sane range
assert.equal(r.delivery, 'menacing calm'); assert.equal(r.offline, 5);
assert.equal(p.deliver('There are no strings on me.'), '[menacing calm] There are no strings on me.');
assert.equal(p.deliver('[whisper] Quiet.'), '[whisper] Quiet.');            // a line's own direction wins
assert.match(p.prompt(), /PLAYING A CHARACTER: Ultron/);
assert.equal(changed, 1);
const again = createPersona({ reg, cfgStore });                              // still Ultron after a restart
assert.equal(again.get().who, 'Ultron');
assert.match(tools.stop_being({}), /Back to being Jarvis/);
assert.equal(again.get(), null); assert.equal(again.deliver('Hi.'), 'Hi.');   // (the tools now belong to the second copy, as after a restart)
assert.equal(tools.become({ who: 'Yoda', gender: 'male', voice: 'nobody' }) && again.get().voice, 'troy');   // unknown voice: a sensible one
console.log('persona OK');
