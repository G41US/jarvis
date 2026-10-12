// node tests/stt.test.mjs - end-of-speech timing in background noise (the "30 seconds late" bug)
import { SttPipeline } from '../app/src/main/assets/www/local/stt.js';
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + JSON.stringify(x))); if (!c) fails++; };
const CH = 1280, MS = 80;                                         // native chunks: 80 ms
let rnd = 1; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) - 0.5;
const noise = a => Int16Array.from({ length: CH }, () => Math.round(rand() * 2 * a * 1.7));
const voice = a => Int16Array.from({ length: CH }, (_, i) => Math.round(a * Math.sin(i / 6) * (0.6 + 0.4 * Math.sin(i / 90)) + rand() * 300));
function rig() {
  let t = 0; const got = [];
  const p = new SttPipeline({ now: () => t, transcribe: async f => `clip of ${Math.round(f.length / 16)} ms`, onTranscript: (text, info) => got.push({ text, ...info, at: t }) });
  return { p, got, tick: () => { t += MS; }, get t() { return t; } };
}
const settle = () => new Promise(r => setTimeout(r, 5));

// 1. phone speech detector in loud steady noise (rms ~400, far above the old threshold of ~120)
{ const r = rig();
  for (let i = 0; i < 25; i++) { r.p.feed(noise(400), 0.03); r.tick(); }                 // 2 s of noise
  for (let i = 0; i < 25; i++) { r.p.feed(voice(3000), 0.97); r.tick(); }                // 2 s of talking
  const stopped = r.t; let ended = null;
  for (let i = 0; i < 200 && ended === null; i++) { r.p.feed(noise(400), 0.04); r.tick(); await settle(); if (r.got.length) ended = r.got[0].endedAt; }
  check('speech detector: clip ends ~0.55 s after you stop, even in loud noise', ended !== null && ended - stopped <= 700, { ended, stopped });
  check('speech detector: clip holds just your words (~2.9 s, not 12-15 s)', r.got[0] && r.got[0].audioMs < 3200 && r.got[0].why === 'pause', r.got[0]); }

// 2. loudness fallback (model not loaded): learns the noise while idle, then ends quickly too
{ const r = rig();
  for (let i = 0; i < 60; i++) { r.p.vad.track(398); r.tick(); }                         // the app learns the room while idle (shim: __jvLevel)
  for (let i = 0; i < 20; i++) { r.p.feed(voice(4000)); r.tick(); }
  const stopped = r.t; let ended = null;
  for (let i = 0; i < 200 && ended === null; i++) { r.p.feed(noise(400)); r.tick(); await settle(); if (r.got.length) ended = r.got[0].endedAt; }
  check('loudness fallback: ends within 0.8 s in steady noise', ended !== null && ended - stopped <= 800, { ended, stopped, got: r.got[0] }); }

// 2b. fallback, worst case: noise starts after the room was learned quiet; the clip still closes long before the 12 s cut
{ const r = rig();
  for (let i = 0; i < 60; i++) { r.p.vad.track(40); r.tick(); }
  for (let i = 0; i < 20; i++) { r.p.feed(voice(4000)); r.tick(); }
  const stopped = r.t; let ended = null;
  for (let i = 0; i < 200 && ended === null; i++) { r.p.feed(noise(400)); r.tick(); await settle(); if (r.got.length) ended = r.got[0].endedAt; }
  check('fallback, noise appears mid-sentence: closes within ~6 s (was 15)', ended !== null && ended - stopped <= 6000, { ended, stopped }); }

// 3. a cough or click doesn't start a clip that waits for 12 s
{ const r = rig();
  for (let i = 0; i < 10; i++) { r.p.feed(noise(100), 0.02); r.tick(); }
  r.p.feed(voice(5000), 0.8); r.tick();
  for (let i = 0; i < 20; i++) { r.p.feed(noise(100), 0.02); r.tick(); }
  await settle();
  check('a single blip is dropped, nothing sent', r.got.length === 0 && r.p.active === false, r.got); }

// 4. words come back in the order you said them even when transcriptions overlap
{ let t = 0; const got = []; const delays = [400, 20];
  const p = new SttPipeline({ now: () => t, transcribe: f => new Promise(res => setTimeout(() => res(`len ${f.length}`), delays.shift() ?? 0)), onTranscript: x => got.push(x) });
  const say = (n) => { for (let i = 0; i < n; i++) { p.feed(voice(3000), 0.95); t += MS; } for (let i = 0; i < 9; i++) { p.feed(noise(50), 0.02); t += MS; } };
  say(10); say(4);
  await new Promise(r => setTimeout(r, 600));
  const len = s => Number(s.split(' ')[1]);
  check('overlapping transcriptions delivered in order', got.length === 2 && len(got[0]) > len(got[1]), got); }

// 5. very long speech is still cut at 12 s (safety net)
{ const r = rig();
  for (let i = 0; i < 170; i++) { r.p.feed(voice(3000), 0.95); r.tick(); }
  await settle();
  check('12 s safety cut still works', r.got.length >= 1 && r.got[0].why === 'max', r.got[0]); }

console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
