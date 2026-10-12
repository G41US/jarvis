package com.jarvis.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The arithmetic of face recognition, free of Android so it can be tested on a computer (tests/face): fitting a photo into
 * YuNet's 640x640 input, decoding YuNet's outputs into faces, aligning a face to SFace's 112x112 template, and comparing
 * face signatures. Mirrors OpenCV's FaceDetectorYN / FaceRecognizerSF (what the PC version uses), checked against them.
 */
public final class FaceMath {
    public static final int SIZE = 640;
    private static final double[][] DST = {{38.2946, 51.6963}, {73.5318, 51.5014}, {56.0252, 71.7366}, {41.5493, 92.3655}, {70.7299, 92.2041}};
    private FaceMath() { }

    /** A detected face in the original photo's pixels: box, 5 landmarks (eyes, nose, mouth corners), score. */
    public static final class Face {
        public float x, y, w, h, score;
        public final float[] lm = new float[10];
    }

    /** The letterboxed input for YuNet. */
    public static final class Input {
        public final float[] blob = new float[3 * SIZE * SIZE];    // 1x3x640x640, BGR planes, 0-255
        public float sx, sy;                                        // resized size / original size
    }

    /** rgb: packed 0xRRGGBB (alpha ignored), row-major w x h. The picture is scaled to fit 640x640 and sits top-left; the rest is black. */
    public static Input letterbox(int[] rgb, int w, int h) {
        Input in = new Input();
        double k = Math.min((double) SIZE / w, (double) SIZE / h);
        int dw = (int) Math.max(1, Math.min(SIZE, Math.round(w * k))), dh = (int) Math.max(1, Math.min(SIZE, Math.round(h * k)));
        in.sx = (float) dw / w;
        in.sy = (float) dh / h;
        double fx = (double) w / dw, fy = (double) h / dh;
        int plane = SIZE * SIZE;
        for (int y = 0; y < dh; y++) {
            double sy = (y + 0.5) * fy - 0.5;
            sy = Math.min(Math.max(sy, 0.0), h - 1.0);
            int y0 = (int) Math.floor(sy), y1 = Math.min(y0 + 1, h - 1);
            double wy = sy - y0;
            for (int x = 0; x < dw; x++) {
                double sx = (x + 0.5) * fx - 0.5;
                sx = Math.min(Math.max(sx, 0.0), w - 1.0);
                int x0 = (int) Math.floor(sx), x1 = Math.min(x0 + 1, w - 1);
                double wx = sx - x0;
                int p00 = rgb[y0 * w + x0], p01 = rgb[y0 * w + x1], p10 = rgb[y1 * w + x0], p11 = rgb[y1 * w + x1];
                int o = y * SIZE + x;
                for (int ch = 0; ch < 3; ch++) {                    // ch 0 = R, 1 = G, 2 = B
                    int sh = 16 - 8 * ch;
                    double top = ((p00 >> sh) & 255) * (1 - wx) + ((p01 >> sh) & 255) * wx;
                    double bot = ((p10 >> sh) & 255) * (1 - wx) + ((p11 >> sh) & 255) * wx;
                    in.blob[(2 - ch) * plane + o] = (float) (top * (1 - wy) + bot * wy);   // BGR planes
                }
            }
        }
        return in;
    }

    /**
     * YuNet outputs (index s = 0,1,2 for strides 8,16,32): cls[s], obj[s] (n), bbox[s] (n*4), kps[s] (n*10).
     * Returns faces in the original photo's pixels, best first, after non-maximum suppression.
     */
    public static List<Face> decode(float[][] cls, float[][] obj, float[][] bbox, float[][] kps, float scoreThr, float nmsThr, float sx, float sy) {
        List<Face> all = new ArrayList<>();
        int[] strides = {8, 16, 32};
        for (int si = 0; si < 3; si++) {
            int s = strides[si], cols = SIZE / s, rows = SIZE / s;
            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    int i = r * cols + c;
                    double cs = Math.min(Math.max(cls[si][i], 0f), 1f), os = Math.min(Math.max(obj[si][i], 0f), 1f);
                    double score = Math.sqrt(cs * os);
                    if (score < scoreThr) continue;
                    double cx = (c + bbox[si][i * 4]) * s, cy = (r + bbox[si][i * 4 + 1]) * s;
                    double bw = Math.exp(bbox[si][i * 4 + 2]) * s, bh = Math.exp(bbox[si][i * 4 + 3]) * s;
                    Face f = new Face();
                    f.x = (float) (cx - bw / 2); f.y = (float) (cy - bh / 2); f.w = (float) bw; f.h = (float) bh; f.score = (float) score;
                    for (int n = 0; n < 5; n++) {
                        f.lm[2 * n] = (float) ((kps[si][i * 10 + 2 * n] + c) * s);
                        f.lm[2 * n + 1] = (float) ((kps[si][i * 10 + 2 * n + 1] + r) * s);
                    }
                    all.add(f);
                }
            }
        }
        Collections.sort(all, (a, b) -> Float.compare(b.score, a.score));
        List<Face> keep = new ArrayList<>();
        for (Face f : all) {
            boolean ok = true;
            for (Face g : keep) {
                double ix = Math.max(0.0, Math.min(f.x + f.w, g.x + g.w) - Math.max(f.x, g.x));
                double iy = Math.max(0.0, Math.min(f.y + f.h, g.y + g.h) - Math.max(f.y, g.y));
                double inter = ix * iy, union = (double) f.w * f.h + (double) g.w * g.h - inter;
                if (union > 0 && inter / union > nmsThr) { ok = false; break; }
            }
            if (ok) keep.add(f);
        }
        for (Face f : keep) {
            f.x /= sx; f.y /= sy; f.w /= sx; f.h /= sy;
            for (int j = 0; j < 10; j += 2) { f.lm[j] /= sx; f.lm[j + 1] /= sy; }
        }
        return keep;
    }

    /** The largest face (the person nearest the camera), or null. */
    public static Face largest(List<Face> faces) {
        Face best = null;
        for (Face f : faces) if (best == null || f.w * f.h > best.w * best.h) best = f;
        return best;
    }

    /** 2x3 matrix {a, b, tx, c, d, ty} mapping the 5 landmarks onto SFace's template (least-squares similarity; = OpenCV's alignCrop). */
    public static double[] similarity(float[] lm) {
        double smx = 0, smy = 0, dmx = 0, dmy = 0;
        for (int i = 0; i < 5; i++) { smx += lm[2 * i]; smy += lm[2 * i + 1]; dmx += DST[i][0]; dmy += DST[i][1]; }
        smx /= 5; smy /= 5; dmx /= 5; dmy /= 5;
        double den = 0, na = 0, nb = 0;
        for (int i = 0; i < 5; i++) {
            double sx = lm[2 * i] - smx, sy = lm[2 * i + 1] - smy, dx = DST[i][0] - dmx, dy = DST[i][1] - dmy;
            den += sx * sx + sy * sy;
            na += dx * sx + dy * sy;
            nb += dy * sx - dx * sy;
        }
        double a = na / den, b = nb / den;
        return new double[]{a, -b, dmx - (a * smx - b * smy), b, a, dmy - (b * smx + a * smy)};
    }

    /** The aligned face for SFace: 1x3x112x112, RGB planes, 0-255 (bilinear, black outside the photo). */
    public static float[] alignedBlob(int[] rgb, int w, int h, double[] m) {
        final int n = 112, plane = n * n;
        float[] out = new float[3 * plane];
        double a = m[0], b = m[1], tx = m[2], c = m[3], d = m[4], ty = m[5], det = a * d - b * c;
        double ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) {
                double u = x - tx, v = y - ty, sx = ia * u + ib * v, sy = ic * u + id * v;
                int x0 = (int) Math.floor(sx), y0 = (int) Math.floor(sy);
                double wx = sx - x0, wy = sy - y0;
                double r = 0, g = 0, bl = 0;
                for (int yy = 0; yy < 2; yy++) {
                    int py = y0 + yy;
                    if (py < 0 || py >= h) continue;
                    double ww = yy == 0 ? 1 - wy : wy;
                    for (int xx = 0; xx < 2; xx++) {
                        int px = x0 + xx;
                        if (px < 0 || px >= w) continue;
                        double k = ww * (xx == 0 ? 1 - wx : wx);
                        int p = rgb[py * w + px];
                        r += ((p >> 16) & 255) * k; g += ((p >> 8) & 255) * k; bl += (p & 255) * k;
                    }
                }
                int o = y * n + x;
                out[o] = (float) r; out[plane + o] = (float) g; out[2 * plane + o] = (float) bl;
            }
        }
        return out;
    }

    public static double cosine(float[] a, float[] b) {
        double dot = 0, na = 0, nb = 0;
        for (int i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return na < 1e-12 || nb < 1e-12 ? 0 : dot / Math.sqrt(na * nb);
    }
}
