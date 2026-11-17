// The phone's mind with a scripted model: a mission runs and reports back, a correction becomes a lesson, news gets followed.
import assert from 'node:assert/strict';
import { Registry } from '../app/src/main/assets/www/local/tools.js';
import { createMind, timing, isCorrection, newsTopic, freshTitles } from '../app/src/main/assets/www/local/mind.js';
console.warn = () => {};
timing.missionPause = 0;
assert.ok(isCorrection('No, I said France not Germany') && isCorrection('next time just give me the headline') && !isCorrection("what's the weather"));
assert.equal(newsTopic("What's happening in France?"), 'France'); assert.equal(newsTopic('play some music'), '');
assert.deepEqual(freshTitles(['France protests continue in Paris'], ['Protests continue in Paris, France', 'Macron names new prime minister']), ['Macron names new prime minister']);

const store = {}, kv = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };
const cfg = { get: (k, d) => d, set() {} }, said = [], notes = [];
const reply = o => ({ choices: [{ message: { content: JSON.stringify(o) } }] });
const brain = { usable: () => true, refreshPrompt() {}, groqJson: async kw => {
  const sys = kw.messages[0].content, user = kw.messages[1].content;
  if (sys.includes('research mission')) return reply(user.includes('1. ') ? { tool: 'finish', result: 'Get the ThinkPad E14.', summary: 'The ThinkPad E14 wins.' } : { tool: 'search_web', input: 'best budget laptops' });
  if (sys.includes('corrected you')) return reply({ lesson: 'Give news for the exact place he names.' });
  return reply({});
} };
const reg = new Registry();
reg.add('search_web', '', {}, [], () => '- ThinkPad E14 review: great keyboard');
reg.add('take_note', '', {}, [], a => { notes.push(a.text); return 'Saved.'; });
globalThis.document = { hidden: false };
const mind = createMind({ brain, kv, config: cfg, broadcast: m => said.push(m), reg, ctx: {}, log: () => {} });

assert.match(await reg.exec('mission', JSON.stringify({ action: 'start', goal: 'the best budget laptop' })), /^On it/);
for (let i = 0; i < 50 && !notes.length; i++) await new Promise(r => setTimeout(r, 10));
assert.ok(notes[0].includes('ThinkPad'));
assert.match(await reg.exec('mission', '{"action":"report"}'), /ThinkPad/);
assert.ok(said.some(m => m.includes('ThinkPad E14 wins')), said);

mind.noteUser('No, I said France not Germany');
for (let i = 0; i < 50 && !mind.state().lessons.length; i++) await new Promise(r => setTimeout(r, 10));
assert.match(await reg.exec('lessons', '{"action":"list"}'), /exact place/);
assert.match(mind.prompt(), /exact place/);
mind.noteUser("What's happening in France?");
assert.match(mind.prompt(), /keep an eye on for him: France/);
process.stdout.write('phone mind agent OK\n');
