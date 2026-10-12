"""Reference port of the phone's face pipeline (FaceMath.java mirrors this line for line).
YuNet (2023mar, fixed 640x640 input) + SFace, the same models OpenCV's FaceDetectorYN / FaceRecognizerSF use on the PC."""
import math
import numpy as np

SIZE = 640
DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], np.float64)


def resize_bilinear(rgb, dw, dh):
    """Half-pixel-centre bilinear resize of an HxWx3 uint8 image (what FaceMath.resize does)."""
    sh, sw = rgb.shape[:2]
    out = np.zeros((dh, dw, 3), np.float32)
    fx, fy = sw / dw, sh / dh
    src = rgb.astype(np.float32)
    for y in range(dh):
        sy = (y + 0.5) * fy - 0.5; sy = min(max(sy, 0.0), sh - 1.0)
        y0 = int(math.floor(sy)); y1 = min(y0 + 1, sh - 1); wy = sy - y0
        for x in range(dw):
            sx = (x + 0.5) * fx - 0.5; sx = min(max(sx, 0.0), sw - 1.0)
            x0 = int(math.floor(sx)); x1 = min(x0 + 1, sw - 1); wx = sx - x0
            top = src[y0, x0] * (1 - wx) + src[y0, x1] * wx
            bot = src[y1, x0] * (1 - wx) + src[y1, x1] * wx
            out[y, x] = top * (1 - wy) + bot * wy
    return out


def letterbox(rgb):
    """-> (blob 1x3x640x640 in BGR order, 0-255, scale). The picture sits top-left, the rest is black."""
    h, w = rgb.shape[:2]
    k = min(SIZE / w, SIZE / h)
    dw, dh = max(1, min(SIZE, round(w * k))), max(1, min(SIZE, round(h * k)))
    r = resize_bilinear(rgb, dw, dh)
    blob = np.zeros((1, 3, SIZE, SIZE), np.float32)
    blob[0, 0, :dh, :dw] = r[:, :, 2]; blob[0, 1, :dh, :dw] = r[:, :, 1]; blob[0, 2, :dh, :dw] = r[:, :, 0]
    return blob, dw / w, dh / h


def decode(outs, score_thr=0.6, nms_thr=0.3, sx=1.0, sy=1.0):
    """outs: dict cls_8.. obj_8.. bbox_8.. kps_8.. (flattened). -> list of [x, y, w, h, l0x, l0y, ... l4x, l4y, score] in original pixels."""
    faces = []
    for s in (8, 16, 32):
        cols = rows = SIZE // s
        cls, obj, bb, kp = outs['cls_%d' % s].ravel(), outs['obj_%d' % s].ravel(), outs['bbox_%d' % s].ravel(), outs['kps_%d' % s].ravel()
        for r in range(rows):
            for c in range(cols):
                i = r * cols + c
                cs = min(max(float(cls[i]), 0.0), 1.0); os_ = min(max(float(obj[i]), 0.0), 1.0)
                score = math.sqrt(cs * os_)
                if score < score_thr: continue
                cx = (c + float(bb[i * 4])) * s; cy = (r + float(bb[i * 4 + 1])) * s
                w = math.exp(float(bb[i * 4 + 2])) * s; h = math.exp(float(bb[i * 4 + 3])) * s
                f = [cx - w / 2, cy - h / 2, w, h]
                for n in range(5): f += [(float(kp[i * 10 + 2 * n]) + c) * s, (float(kp[i * 10 + 2 * n + 1]) + r) * s]
                f.append(score); faces.append(f)
    faces.sort(key=lambda f: -f[14])
    keep = []
    for f in faces:
        ok = True
        for g in keep:
            ix = max(0.0, min(f[0] + f[2], g[0] + g[2]) - max(f[0], g[0])); iy = max(0.0, min(f[1] + f[3], g[1] + g[3]) - max(f[1], g[1]))
            inter = ix * iy; union = f[2] * f[3] + g[2] * g[3] - inter
            if union > 0 and inter / union > nms_thr: ok = False; break
        if ok: keep.append(f)
    out = []
    for f in keep:
        g = list(f)
        for j in range(0, 14, 2): g[j] /= sx; g[j + 1] /= sy
        g[2] = f[2] / sx; g[3] = f[3] / sy
        out.append(g)
    return out


def similarity(lm):
    """5 landmarks -> 2x3 matrix taking the face to SFace's 112x112 template (least-squares similarity, = OpenCV's Umeyama)."""
    src = np.array(lm, np.float64).reshape(5, 2)
    sm, dm = src.mean(0), DST.mean(0)
    s, d = src - sm, DST - dm
    den = (s ** 2).sum()
    a = (d[:, 0] * s[:, 0] + d[:, 1] * s[:, 1]).sum() / den
    b = (d[:, 1] * s[:, 0] - d[:, 0] * s[:, 1]).sum() / den
    return np.array([[a, -b, dm[0] - (a * sm[0] - b * sm[1])], [b, a, dm[1] - (b * sm[0] + a * sm[1])]])


def warp(rgb, M, size=112):
    """Inverse-map bilinear warp, black outside (warpAffine INTER_LINEAR, BORDER_CONSTANT). -> size x size x 3 float."""
    a, b, tx = M[0]; c, d, ty = M[1]
    det = a * d - b * c
    ia, ib, ic, id_ = d / det, -b / det, -c / det, a / det
    h, w = rgb.shape[:2]; src = rgb.astype(np.float32)
    out = np.zeros((size, size, 3), np.float32)
    for y in range(size):
        for x in range(size):
            u, v = x - tx, y - ty
            sx, sy = ia * u + ib * v, ic * u + id_ * v
            x0, y0 = int(math.floor(sx)), int(math.floor(sy)); wx, wy = sx - x0, sy - y0
            acc = np.zeros(3, np.float32)
            for yy, wyy in ((y0, 1 - wy), (y0 + 1, wy)):
                for xx, wxx in ((x0, 1 - wx), (x0 + 1, wx)):
                    if 0 <= xx < w and 0 <= yy < h: acc += src[yy, xx] * (wxx * wyy)
            out[y, x] = acc
    return out


def sface_blob(aligned_rgb):
    """SFace wants RGB planes, 0-255 (OpenCV: blobFromImage(bgr, swapRB=true))."""
    return np.ascontiguousarray(aligned_rgb.transpose(2, 0, 1)[None].astype(np.float32))
