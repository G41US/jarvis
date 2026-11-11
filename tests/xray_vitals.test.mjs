// The X-ray mirror's real measurements on made-up signals with a known answer (desktop/app/xray.js).
import assert from 'node:assert/strict';
import { posPulse, breathRate, resample, tiredness } from '../desktop/app/xray.js';

let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
// 20 s of face colour at an uneven ~28 fps: 72 beats a minute in the green channel, slow lighting drift and camera noise
for (const bpm of [58, 72, 104]) {
  const ts = [], vals = [];
  for (let t = 0; t < 20; t += 1 / 28 + rnd() * 0.01) {
    const beat = Math.sin(2 * Math.PI * bpm / 60 * t), drift = 4 * Math.sin(2 * Math.PI * 0.05 * t);
    ts.push(t); vals.push([150 + drift + 0.15 * beat + rnd() * 0.6, 110 + drift + 0.5 * beat + rnd() * 0.6, 95 + drift + 0.1 * beat + rnd() * 0.6]);
  }
  const rs = [0, 1, 2].map(c => resample(ts, vals.map(v => v[c]), 30)), rgb = rs[0].map((_, i) => [rs[0][i], rs[1][i], rs[2][i]]);
  const p = posPulse(rgb, 30);
  assert.ok(Math.abs(p.bpm - bpm) <= 2, `pulse ${bpm}: got ${p.bpm}`); assert.ok(p.snr > 0.3, `pulse snr ${p.snr}`);
}
// pure noise must not look like a pulse
{ const rgb = Array.from({ length: 600 }, () => [150 + rnd() * 2, 110 + rnd() * 2, 95 + rnd() * 2]); assert.ok(posPulse(rgb, 30).snr < 0.3, 'noise is not a pulse'); }
// breathing: 15 a minute as a slow shift with drift
{ const sig = Array.from({ length: 300 }, (_, i) => 3 * Math.sin(2 * Math.PI * 0.25 * i / 10) + i * 0.02 + rnd()); const b = breathRate(sig, 10); assert.ok(Math.abs(b.rpm - 15) <= 1, `breathing ${b.rpm}`); }
assert.equal(breathRate([1, 2, 3], 10).rpm, 0);
assert.equal(tiredness(15, 0.02, 0), 'alert'); assert.equal(tiredness(30, 0.1, 0), 'a bit tired'); assert.equal(tiredness(32, 0.2, 2), 'tired');
console.log('xray vitals OK');
