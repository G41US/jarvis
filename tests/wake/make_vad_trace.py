#!/usr/bin/env python3
"""Records Silero VAD's official streaming steps on real speech + noise, for the Java replay test (tests/wake/SileroVadTest.java)."""
import os, wave, numpy as np, onnxruntime as ort
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
MODEL = os.path.join(ROOT, 'app/src/main/assets/vad/silero_vad.onnx'); D = os.environ.get('OWW_SRC', '/home/claude/dscripka/openwakeword') + '/tests/data/'
def wav(p): w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
rng = np.random.default_rng(5); noise = lambda n, a: rng.normal(0, a, n)
sp = wav(D + 'hey_jane.wav').astype(np.float64)
x = np.concatenate([noise(16000, 400), sp + noise(len(sp), 400), noise(12000, 400), wav(D + 'alexa_test.wav') + noise(len(wav(D + 'alexa_test.wav')), 150), noise(16000, 150)])
x = np.clip(x, -32768, 32767).astype(np.int16); x = x[:len(x) // 1280 * 1280]; chunks = x.reshape(-1, 1280)
s = ort.InferenceSession(MODEL); state = np.zeros((2, 1, 128), np.float32); ctx = np.zeros((1, 64), np.float32)
calls, per_chunk, last, buf = [], [], 0.0, np.zeros(0, np.float32)
for c in chunks:                                   # mirror of SileroVad.java (official wrapper: 64-sample context + state)
    buf = np.concatenate([buf, c.astype(np.float32) / 32768]); best = -1.0
    while len(buf) >= 512:
        inp = np.concatenate([ctx, buf[None, :512]], axis=1).astype(np.float32); buf = buf[512:]
        out, st2 = s.run(None, {'input': inp, 'state': state, 'sr': np.array(16000, dtype=np.int64)})
        calls.append((float(np.float64(inp).sum()), float(np.float64(state).sum()), [float(out[0][0])] + st2.ravel().astype(float).tolist()))
        state = st2.astype(np.float32); ctx = inp[:, -64:]; best = max(best, float(out[0][0]))
    if best >= 0: last = best
    per_chunk.append(last)
with open(os.path.join(HERE, 'vad_trace.txt'), 'w') as f:
    f.write(f"{len(chunks)}\n"); [f.write(' '.join(str(int(v)) for v in c) + '\n') for c in chunks]
    f.write(f"{len(calls)}\n"); [f.write(f"{a!r} {b!r} {len(o)} " + ' '.join(repr(v) for v in o) + '\n') for a, b, o in calls]
    f.write(' '.join(repr(v) for v in per_chunk) + '\n')
p = np.array(per_chunk); print(f'{len(chunks)} chunks, {len(calls)} frames; speech chunks (p>=0.5): {(p >= 0.5).sum()}, noise-only max {p[:12].max():.3f}')
