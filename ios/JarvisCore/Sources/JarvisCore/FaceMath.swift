import Foundation

/// The arithmetic of face recognition (a line-by-line port of FaceMath.java, checked against the same trace):
/// fitting a photo into YuNet's 640x640 input, decoding YuNet's outputs into faces, aligning a face to SFace's
/// 112x112 template, and comparing face signatures.
public enum FaceMath {
    public static let size = 640
    static let dst: [(Double, Double)] = [(38.2946, 51.6963), (73.5318, 51.5014), (56.0252, 71.7366), (41.5493, 92.3655), (70.7299, 92.2041)]

    /// A detected face in the original photo's pixels: box, 5 landmarks (eyes, nose, mouth corners), score.
    public struct Face {
        public var x: Float = 0, y: Float = 0, w: Float = 0, h: Float = 0, score: Float = 0
        public var lm = [Float](repeating: 0, count: 10)
        public init() {}
    }

    /// The letterboxed input for YuNet: 1x3x640x640, BGR planes, 0-255.
    public struct Input {
        public var blob: [Float]
        public var sx: Float
        public var sy: Float
    }

    /// rgb: packed 0xRRGGBB, row-major w x h. Scaled to fit 640x640, top-left; the rest is black.
    public static func letterbox(_ rgb: [UInt32], _ w: Int, _ h: Int) -> Input {
        let S = size, plane = S * S
        var blob = [Float](repeating: 0, count: 3 * plane)
        let k = min(Double(S) / Double(w), Double(S) / Double(h))
        let dw = Int(max(1, min(Double(S), (Double(w) * k + 0.5).rounded(.down))))
        let dh = Int(max(1, min(Double(S), (Double(h) * k + 0.5).rounded(.down))))
        let sx = Float(dw) / Float(w), sy = Float(dh) / Float(h)
        let fx = Double(w) / Double(dw), fy = Double(h) / Double(dh)
        blob.withUnsafeMutableBufferPointer { out in
            rgb.withUnsafeBufferPointer { px in
                for y in 0..<dh {
                    var syy = (Double(y) + 0.5) * fy - 0.5
                    syy = min(max(syy, 0.0), Double(h) - 1.0)
                    let y0 = Int(syy.rounded(.down)), y1 = min(y0 + 1, h - 1)
                    let wy = syy - Double(y0)
                    for x in 0..<dw {
                        var sxx = (Double(x) + 0.5) * fx - 0.5
                        sxx = min(max(sxx, 0.0), Double(w) - 1.0)
                        let x0 = Int(sxx.rounded(.down)), x1 = min(x0 + 1, w - 1)
                        let wx = sxx - Double(x0)
                        let p00 = px[y0 * w + x0], p01 = px[y0 * w + x1], p10 = px[y1 * w + x0], p11 = px[y1 * w + x1]
                        let o = y * S + x
                        for ch in 0..<3 {                                   // ch 0 = R, 1 = G, 2 = B
                            let sh = UInt32(16 - 8 * ch)
                            let top = Double((p00 >> sh) & 255) * (1 - wx) + Double((p01 >> sh) & 255) * wx
                            let bot = Double((p10 >> sh) & 255) * (1 - wx) + Double((p11 >> sh) & 255) * wx
                            out[(2 - ch) * plane + o] = Float(top * (1 - wy) + bot * wy)   // BGR planes
                        }
                    }
                }
            }
        }
        return Input(blob: blob, sx: sx, sy: sy)
    }

    /// YuNet outputs (index 0,1,2 for strides 8,16,32): cls, obj (n), bbox (n*4), kps (n*10).
    /// Faces in the original photo's pixels, best first, after non-maximum suppression.
    public static func decode(cls: [[Float]], obj: [[Float]], bbox: [[Float]], kps: [[Float]], scoreThr: Float, nmsThr: Float, sx: Float, sy: Float) -> [Face] {
        var all: [Face] = []
        let strides = [8, 16, 32]
        for si in 0..<3 {
            let s = strides[si], cols = size / s, rows = size / s
            let C = cls[si], O = obj[si], B = bbox[si], K = kps[si]
            for r in 0..<rows {
                for c in 0..<cols {
                    let i = r * cols + c
                    let cs = Double(min(max(C[i], 0), 1)), os = Double(min(max(O[i], 0), 1))
                    let score = (cs * os).squareRoot()
                    if score < Double(scoreThr) { continue }
                    let cx = Double((Float(c) + B[i * 4]) * Float(s)), cy = Double((Float(r) + B[i * 4 + 1]) * Float(s))
                    let bw = exp(Double(B[i * 4 + 2])) * Double(s), bh = exp(Double(B[i * 4 + 3])) * Double(s)
                    var f = Face()
                    f.x = Float(cx - bw / 2); f.y = Float(cy - bh / 2); f.w = Float(bw); f.h = Float(bh); f.score = Float(score)
                    for n in 0..<5 {
                        f.lm[2 * n] = (K[i * 10 + 2 * n] + Float(c)) * Float(s)
                        f.lm[2 * n + 1] = (K[i * 10 + 2 * n + 1] + Float(r)) * Float(s)
                    }
                    all.append(f)
                }
            }
        }
        all.sort { $0.score > $1.score }
        var keep: [Face] = []
        for f in all {
            var ok = true
            for g in keep {
                let ix = max(0.0, Double(min(f.x + f.w, g.x + g.w) - max(f.x, g.x)))
                let iy = max(0.0, Double(min(f.y + f.h, g.y + g.h) - max(f.y, g.y)))
                let inter = ix * iy, union = Double(f.w) * Double(f.h) + Double(g.w) * Double(g.h) - inter
                if union > 0 && inter / union > Double(nmsThr) { ok = false; break }
            }
            if ok { keep.append(f) }
        }
        for j in keep.indices {
            keep[j].x /= sx; keep[j].y /= sy; keep[j].w /= sx; keep[j].h /= sy
            for k in stride(from: 0, to: 10, by: 2) { keep[j].lm[k] /= sx; keep[j].lm[k + 1] /= sy }
        }
        return keep
    }

    /// The largest face (the person nearest the camera), or nil.
    public static func largest(_ faces: [Face]) -> Face? {
        var best: Face? = nil
        for f in faces where best == nil || f.w * f.h > best!.w * best!.h { best = f }
        return best
    }

    /// 2x3 matrix [a, b, tx, c, d, ty] mapping the 5 landmarks onto SFace's template (least-squares similarity).
    public static func similarity(_ lm: [Float]) -> [Double] {
        var smx = 0.0, smy = 0.0, dmx = 0.0, dmy = 0.0
        for i in 0..<5 { smx += Double(lm[2 * i]); smy += Double(lm[2 * i + 1]); dmx += dst[i].0; dmy += dst[i].1 }
        smx /= 5; smy /= 5; dmx /= 5; dmy /= 5
        var den = 0.0, na = 0.0, nb = 0.0
        for i in 0..<5 {
            let sx = Double(lm[2 * i]) - smx, sy = Double(lm[2 * i + 1]) - smy, dx = dst[i].0 - dmx, dy = dst[i].1 - dmy
            den += sx * sx + sy * sy
            na += dx * sx + dy * sy
            nb += dy * sx - dx * sy
        }
        let a = na / den, b = nb / den
        return [a, -b, dmx - (a * smx - b * smy), b, a, dmy - (b * smx + a * smy)]
    }

    /// The aligned face for SFace: 1x3x112x112, RGB planes, 0-255 (bilinear, black outside the photo).
    public static func alignedBlob(_ rgb: [UInt32], _ w: Int, _ h: Int, _ m: [Double]) -> [Float] {
        let n = 112, plane = n * n
        var out = [Float](repeating: 0, count: 3 * plane)
        let a = m[0], b = m[1], tx = m[2], c = m[3], d = m[4], ty = m[5], det = a * d - b * c
        let ia = d / det, ib = -b / det, ic = -c / det, id = a / det
        for y in 0..<n {
            for x in 0..<n {
                let u = Double(x) - tx, v = Double(y) - ty, sx = ia * u + ib * v, sy = ic * u + id * v
                let x0 = Int(sx.rounded(.down)), y0 = Int(sy.rounded(.down))
                let wx = sx - Double(x0), wy = sy - Double(y0)
                var r = 0.0, g = 0.0, bl = 0.0
                for yy in 0..<2 {
                    let py = y0 + yy
                    if py < 0 || py >= h { continue }
                    let ww = yy == 0 ? 1 - wy : wy
                    for xx in 0..<2 {
                        let pxx = x0 + xx
                        if pxx < 0 || pxx >= w { continue }
                        let k = ww * (xx == 0 ? 1 - wx : wx)
                        let p = rgb[py * w + pxx]
                        r += Double((p >> 16) & 255) * k; g += Double((p >> 8) & 255) * k; bl += Double(p & 255) * k
                    }
                }
                let o = y * n + x
                out[o] = Float(r); out[plane + o] = Float(g); out[2 * plane + o] = Float(bl)
            }
        }
        return out
    }

    public static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in 0..<min(a.count, b.count) { dot += Double(a[i] * b[i]); na += Double(a[i] * a[i]); nb += Double(b[i] * b[i]) }
        return na < 1e-12 || nb < 1e-12 ? 0 : dot / (na * nb).squareRoot()
    }
}
