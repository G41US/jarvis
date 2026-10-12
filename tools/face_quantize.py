#!/usr/bin/env python3
"""Shrinks SFace (face signatures) from 38.7 MB to ~10 MB with 8-bit weights, then checks the small model still gives the same
signatures as the full one before it goes into the app. Runs in the GitHub build (it needs the `onnx` package).
  python3 tools/face_quantize.py <sface fp32.onnx> <yunet.onnx> <output sface.onnx> [--no-quantize]
Exit code 0 and an output file only if the check passes; otherwise no file (Jarvis then says face recognition isn't installed)."""
import math, os, sys, tempfile
import numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'face'))
import facepy as F

src, yunet_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
tmp = tempfile.mkdtemp()
if '--no-quantize' in sys.argv:
    small = src
else:
    import onnx
    from onnxruntime.quantization import quantize_dynamic, QuantType
    m = onnx.load(src)
    inits = {i.name for i in m.graph.initializer}
    keep = [i for i in m.graph.input if i.name not in inits]          # weights listed as inputs stop constant folding
    del m.graph.input[:]; m.graph.input.extend(keep)
    clean = os.path.join(tmp, 'clean.onnx'); onnx.save(m, clean)
    small = os.path.join(tmp, 'sface_int8.onnx')
    quantize_dynamic(clean, small, weight_type=QuantType.QInt8, op_types_to_quantize=['Conv', 'MatMul', 'Gemm'])
    print(f'quantized: {os.path.getsize(src) / 1e6:.1f} MB -> {os.path.getsize(small) / 1e6:.1f} MB, IR {onnx.load(small).ir_version}')

so = ort.SessionOptions(); so.log_severity_level = 3
yn = ort.InferenceSession(yunet_path, so, providers=['CPUExecutionProvider'])
full = ort.InferenceSession(src, so, providers=['CPUExecutionProvider'])
lite = ort.InferenceSession(small, so, providers=['CPUExecutionProvider'])
names = [o.name for o in yn.get_outputs()]

def sig(sess, rgb):
    blob, sx, sy = F.letterbox(rgb)
    faces = F.decode(dict(zip(names, yn.run(None, {'input': blob}))), 0.6, 0.3, sx, sy)
    if not faces: return None
    f = max(faces, key=lambda g: g[2] * g[3])
    e = sess.run(None, {sess.get_inputs()[0].name: F.sface_blob(F.warp(rgb, F.similarity(f[4:14])))})[0].ravel()
    return e / np.linalg.norm(e)

def variants(rgb):
    import cv2
    h, w = rgb.shape[:2]
    rot = lambda d: cv2.warpAffine(rgb, cv2.getRotationMatrix2D((w / 2, h / 2), d, 1.0), (w, h))
    yield 'original', rgb
    yield 'tilted left', rot(8); yield 'tilted right', rot(-8)
    yield 'closer', cv2.resize(rgb[h // 8: h - h // 8, w // 8: w - w // 8], (w, h))
    yield 'farther', cv2.copyMakeBorder(cv2.resize(rgb, (w * 3 // 4, h * 3 // 4)), h // 8, h // 8, w // 8, w // 8, cv2.BORDER_CONSTANT)
    yield 'darker', np.clip(rgb.astype(np.int16) - 50, 0, 255).astype(np.uint8)
    yield 'brighter', np.clip(rgb.astype(np.int16) + 40, 0, 255).astype(np.uint8)
    yield 'mirrored', np.ascontiguousarray(rgb[:, ::-1])
    yield 'blurred', cv2.GaussianBlur(rgb, (5, 5), 1.5)

from skimage import data
photo = np.ascontiguousarray(data.astronaut())                     # RGB, one face
agree, same, base = [], [], None
for name, img in variants(photo):
    a, b = sig(full, img), sig(lite, img)
    if a is None or b is None: print(f'  {name}: no face'); continue
    c = float(a @ b); agree.append(c)
    if base is None: base = b
    s = float(base @ b); same.append(s)
    print(f'  {name:12s} small vs full {c:.4f}   same person (small model) {s:.3f}')
ok = len(agree) >= 7 and np.mean(agree) >= 0.97 and min(agree) >= 0.93 and min(same) >= 0.42
msg = f'SFace 8-bit vs full: mean {np.mean(agree):.4f}, worst {min(agree):.4f}; same person across variations: worst {min(same):.3f} (match threshold 0.42); {os.path.getsize(small) / 1e6:.1f} MB'
print(('::notice title=Face recognition::' if ok else '::warning title=Face recognition left out::') + msg)
if ok:
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(small, 'rb') as fi, open(out, 'wb') as fo: fo.write(fi.read())
sys.exit(0 if ok else 1)
