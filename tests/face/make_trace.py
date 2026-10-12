"""Writes the face test trace: a photo, YuNet's raw outputs for it, and what the reference pipeline (facepy.py, checked against
OpenCV) gets at each step. FaceMathTest.java replays it. Run: python3 tests/face/make_trace.py <yunet.onnx> <sface.onnx>"""
import os, struct, sys
import numpy as np, onnxruntime as ort, cv2
sys.path.insert(0, os.path.dirname(__file__)); import facepy as F
HERE = os.path.dirname(os.path.abspath(__file__))
so = ort.SessionOptions(); so.log_severity_level = 3
yn = ort.InferenceSession(sys.argv[1], so, providers=['CPUExecutionProvider'])
bgr = cv2.imread(os.path.join(os.path.dirname(cv2.__file__), '..', 'skimage', 'data', 'astronaut.png')) if len(sys.argv) < 4 else cv2.imread(sys.argv[3])
bgr = bgr[40:400, 20:500]                                                # 480 x 360: not square, so the letterbox matters
rgb = np.ascontiguousarray(bgr[:, :, ::-1]); h, w = rgb.shape[:2]
blob, sx, sy = F.letterbox(rgb)
names = [o.name for o in yn.get_outputs()]; outs = dict(zip(names, yn.run(None, {'input': blob})))
faces = F.decode(outs, 0.6, 0.3, sx, sy)
M = F.similarity(faces[0][4:14]); al = F.sface_blob(F.warp(rgb, M)).ravel()
det = cv2.FaceDetectorYN.create(sys.argv[1], '', (w, h), 0.6, 0.3, 5000); _, cvf = det.detect(bgr)
rec = cv2.FaceRecognizerSF.create(sys.argv[2], '')
alcv = rec.alignCrop(bgr, cvf[0])
with open(os.path.join(HERE, 'trace.bin'), 'wb') as f:
    f.write(struct.pack('<ii', w, h)); f.write(rgb.tobytes())
    for k in ('cls', 'obj', 'bbox', 'kps'):
        for s in (8, 16, 32): a = outs[f'{k}_{s}'].astype('<f4').ravel(); f.write(struct.pack('<i', a.size)); f.write(a.tobytes())
rng = np.random.default_rng(1); bi = rng.integers(0, blob.size, 400); ai = rng.integers(0, al.size, 400)
with open(os.path.join(HERE, 'expected.txt'), 'w') as f:
    f.write(f'scale {sx:.8f} {sy:.8f}\n')
    f.write('blob_sum %.4f\n' % float(blob.astype(np.float64).sum()))
    f.write('blob ' + ' '.join(f'{i}:{blob.ravel()[i]:.5f}' for i in bi) + '\n')
    f.write(f'faces {len(faces)}\n')
    for g in faces: f.write('face ' + ' '.join(f'{v:.5f}' for v in g) + '\n')
    f.write('M ' + ' '.join(f'{v:.8f}' for v in M.ravel()) + '\n')
    f.write('aligned_sum %.4f\n' % float(al.astype(np.float64).sum()))
    f.write('aligned ' + ' '.join(f'{i}:{al[i]:.4f}' for i in ai) + '\n')
    f.write('opencv_face ' + ' '.join(f'{v:.5f}' for v in cvf[0]) + '\n')
print('trace written:', w, 'x', h, len(faces), 'face(s); landmarks vs OpenCV max px diff', float(np.abs(np.array(faces[0][4:14]) - cvf[0][4:14]).max()))
