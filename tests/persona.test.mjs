// Characters ("be Ultron"): the voice is found in Fish Audio's library, he plays the part in that voice until "stop",
// and he stays himself when there's no such voice or no key. The Fish key typed in a message is kept out of the AI.
import assert from 'node:assert/strict';
import { createPersona, findVoice } from '../app/src/main/assets/www/local/persona.js';
const LIB = {
  ultron: [{ _id: 'deku', title: 'Izuku midoriya plus ultra', state: 'trained', task_count: 99999 },
           { _id: 'u1', title: 'Ultron', state: 'trained', task_count: 12350, like_count: 41 }, { _id: 'u2', title: 'Ultron?', state: 'trained', task_count: 9288, like_count: 62 },
           { _id: 'u3', title: 'Ultron', state: 'training', task_count: 50000 }],
  'morgan freeman': [{ _id: 'mf', title: 'Morgan Freeman', state: 'trained', task_count: 60222 }, { _id: 'mx', title: 'Morgan', state: 'trained', task_count: 90000 }],
};
let calls = [];
const fetchFn = async url => { calls.push(url); const q = new URL(url).searchParams.get('title'); return { ok: true, json: async () => ({ items: LIB[q] || [] }) }; };
assert.deepEqual(await findVoice('Ultron', fetchFn), { id: 'u2', title: 'Ultron?' });         // a real match, trained, the most liked
assert.equal((await findVoice('Morgan Freeman', fetchFn)).id, 'mf');                          // every word of the name
assert.equal(await findVoice('Nobody Atall', fetchFn), null);
assert.match(calls[0], /title=ultron&.*language=en/);

const store = new Map(), cfgStore = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) };
const tools = {}, reg = { add: (n, d, p, r, f) => { tools[n] = f; } };
let changed = 0;
const p = createPersona({ reg, cfgStore, fetchFn, onChange: () => changed++ });
assert.ok(tools.become && tools.stop_being);
assert.equal(p.prompt(), ''); assert.equal(p.voice(), null);
assert.match(await tools.become({ who: 'Ultron' }), /Fish Audio key/);                        // no key: asks for it, stays Jarvis
assert.equal(p.get(), null);
assert.equal(p.takeKey('what time is it'), null);
assert.match(p.takeKey('0123456789abcdef0123456789abcdef'), /saved/);                         // the bare key, right after he asked
assert.equal(store.get('fish_key'), '0123456789abcdef0123456789abcdef');
assert.match(await tools.become({ who: 'Nobody Atall' }), /no voice for Nobody Atall/);       // no such voice: stays Jarvis
assert.equal(p.get(), null);
assert.match(await tools.become({ who: 'Ultron', style: 'Grandiose, sardonic.' }), /in their voice/);
assert.deepEqual(p.voice(), { key: '0123456789abcdef0123456789abcdef', id: 'u2' });
assert.match(p.prompt(), /PLAYING A CHARACTER: Ultron.*own voice/s);
assert.match(await tools.try_another_voice({}), /2 of 2/); assert.equal(p.voice().id, 'u1');   // "that's not his voice"
assert.match(await tools.try_another_voice({}), /last voice/); assert.equal(p.voice().id, 'u1');
const again = createPersona({ reg, cfgStore, fetchFn });                                      // still Ultron after a restart
assert.equal(again.get().who, 'Ultron');
assert.match(tools.stop_being({}), /Back to being Jarvis/);
assert.equal(again.get(), null); assert.equal(again.voice(), null);
await tools.become({ who: 'ultron' }); assert.equal(again.voice().id, 'u1');              // the voice he kept comes back
tools.stop_being({});
assert.match(again.takeKey('my fish key is abcdefABCDEF0123456789zzzz'), /saved/);           // "fish" in the message: any time
store.set('persona', JSON.stringify({ who: 'Old', voice: 'troy', pitch: 0.85 }));              // a character from the old lookalike version: ignored
assert.equal(createPersona({ reg, cfgStore, fetchFn }).get(), null);
assert.ok(changed >= 2);
console.log('persona OK');
