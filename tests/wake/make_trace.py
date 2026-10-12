#!/usr/bin/env python3
"""Builds tests/wake/trace.json: runs the OFFICIAL openWakeWord code and a straight re-implementation of the phone's WakeWord.java
on the same audio, checks they agree, and records every model call so the Java class can be replayed against it.
Needs: onnxruntime, numpy, the three models in $OWW_MODELS, the openwakeword source in $OWW_SRC."""
import json, os, sys, types, wave
import numpy as np, onnxruntime as ort

MODELS = os.environ.get('OWW_MODELS', '/home/claude/oww_models'); SRC = os.environ.get('OWW_SRC', '/home/claude/dscripka/openwakeword')
sys.modules.setdefault('tqdm', types.SimpleNamespace(tqdm=lambda x=None, **k: x))
sys.path.insert(0, SRC)
from openwakeword.model import Model

def wav(p):
    w = wave.open(p); a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16); assert w.getframerate() == 16000 and w.getnchannels() == 1; return a
D = os.path.join(SRC, 'tests', 'data')
rng = np.random.default_rng(3)
parts = [rng.integers(-300, 300, 16000).astype(np.int16)]
for f in ['hey_jane.wav', 'alexa_test.wav', 'hey_mycroft_test.wav', 'hey_jane.wav']:
    parts += [wav(os.path.join(D, f)), rng.integers(-200, 200, 8000).astype(np.int16)]
audio = np.concatenate(parts); audio = audio[:len(audio) // 1280 * 1280]
chunks = audio.reshape(-1, 1280)

ref = Model(wakeword_models=[os.path.join(MODELS, 'hey_jarvis_v0.1.onnx')], inference_framework='onnx',
            melspec_model_path=os.path.join(MODELS, 'melspectrogram.onnx'), embedding_model_path=os.path.join(MODELS, 'embedding_model.onnx'))
init_feats = ref.preprocessor.feature_buffer[-16:].astype(np.float32).copy()
name = list(ref.models.keys())[0]
ref_scores = [float(ref.predict(c)[name]) for c in chunks]

# ---- mirror of WakeWord.java, recording each model call
S = {k: ort.InferenceSession(os.path.join(MODELS, k + '.onnx')) for k in ['melspectrogram', 'embedding_model', 'hey_jarvis_v0.1']}
calls = []
def run(k, x):
    sess = S[k]; out = sess.run(None, {sess.get_inputs()[0].name: x})[0].astype(np.float32).ravel()
    calls.append({'m': k[:3], 'n': int(x.size), 'shape': list(x.shape), 'sum': float(np.float64(x).sum()), 'first': float(x.ravel()[0]), 'last': float(x.ravel()[-1]), 'out': out.tolist()})
    return out
raw = np.zeros(0, np.int16); mel = [np.ones(32, np.float32) for _ in range(76)]; feats = [f for f in init_feats]; mine = []; n = 0
for c in chunks:
    raw = np.concatenate([raw, c])[-1760:]
    m = run('melspectrogram', raw.astype(np.float32)[None]).reshape(-1, 32) / 10 + 2
    mel = (mel + list(m))[-76:]
    e = run('embedding_model', np.array(mel, np.float32)[None, :, :, None])
    feats = (feats + [e])[-16:]
    s = run('hey_jarvis_v0.1', np.array(feats, np.float32)[None])[0]
    n += 1; mine.append(0.0 if n <= 5 else float(s))
diff = max(abs(a - b) for a, b in zip(ref_scores, mine))
print(f'{len(chunks)} chunks; max |official - phone algorithm| = {diff:.2e}; official max score {max(ref_scores):.4f}')
assert diff < 1e-4, 'phone algorithm does not match openWakeWord'
json.dump({'init': init_feats.tolist(), 'chunks': chunks.astype(int).tolist(), 'calls': calls, 'scores': mine}, open(os.path.join(os.path.dirname(__file__), 'trace.json'), 'w'))
print('wrote trace.json')
# flat text copy for the Java replay test (no JSON parser in plain Java)
with open(os.path.join(os.path.dirname(__file__), 'trace.txt'), 'w') as f:
    f.write(f"{len(init_feats)} {init_feats.shape[1]}\n" + ' '.join(repr(float(v)) for v in init_feats.ravel()) + '\n')
    f.write(f"{len(chunks)}\n"); [f.write(' '.join(str(int(v)) for v in c) + '\n') for c in chunks]
    f.write(f"{len(calls)}\n")
    for c in calls: f.write(f"{c['m']} {c['n']} {c['sum']!r} {c['first']!r} {c['last']!r} {len(c['out'])} " + ' '.join(repr(v) for v in c['out']) + '\n')
    f.write(' '.join(repr(s) for s in mine) + '\n')
print('wrote trace.txt')
