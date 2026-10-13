import UIKit
import JarvisCore

/// Face recognition on the phone (port of FaceEngine.java): YuNet finds the face, SFace turns it into a signature, and
/// signatures are compared with the people you asked Jarvis to remember (threshold 0.42, as on the PC).
/// Only signatures are kept, on this phone, never photos.
final class Faces {
    static let match = 0.42
    private var yunet: OrtNet?, sface: OrtNet?
    private var loadError = ""
    private let d = UserDefaults.standard
    private let q = DispatchQueue(label: "jarvis.faces", qos: .userInitiated)

    var available: Bool { Ort.path("face/sface.onnx") != nil && Ort.path("face/yunet.onnx") != nil }

    private func load() throws {
        if yunet != nil && sface != nil { return }
        if !loadError.isEmpty { throw NSError(domain: "Faces", code: 1, userInfo: [NSLocalizedDescriptionKey: loadError]) }
        do { yunet = try OrtNet("face/yunet.onnx", threads: 2); sface = try OrtNet("face/sface.onnx", threads: 2) }
        catch { loadError = String(describing: error); throw error }
    }

    /// Packed 0xRRGGBB pixels of a JPEG/PNG (base64 or data URL).
    static func pixels(_ b64: String) -> ([UInt32], Int, Int)? {
        let s = b64.replacingOccurrences(of: "^data:[^,]*,", with: "", options: .regularExpression)
        guard let data = Data(base64Encoded: s, options: .ignoreUnknownCharacters), let img = UIImage(data: data)?.cgImage else { return nil }
        let w = img.width, h = img.height
        var raw = [UInt8](repeating: 0, count: w * h * 4)
        let ok = raw.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        if !ok { return nil }
        var px = [UInt32](repeating: 0, count: w * h)
        for i in 0..<(w * h) { px[i] = (UInt32(raw[4 * i]) << 16) | (UInt32(raw[4 * i + 1]) << 8) | UInt32(raw[4 * i + 2]) }
        return (px, w, h)
    }

    /// The signature of the largest face, or nil when there's no face.
    private func signature(_ b64: String) throws -> [Float]? {
        try load()
        guard let pic = Faces.pixels(b64), let yn = yunet, let sf = sface else { throw NSError(domain: "Faces", code: 2, userInfo: [NSLocalizedDescriptionKey: "not a picture"]) }
        let (px, w, h) = pic
        let input = FaceMath.letterbox(px, w, h)
        let o = try yn.runAll(input.blob, shape: [1, 3, FaceMath.size, FaceMath.size])      // cls 8/16/32, obj, bbox, kps
        guard o.count >= 12 else { throw NSError(domain: "Faces", code: 3, userInfo: [NSLocalizedDescriptionKey: "unexpected detector outputs"]) }
        let faces = FaceMath.decode(cls: Array(o[0..<3]), obj: Array(o[3..<6]), bbox: Array(o[6..<9]), kps: Array(o[9..<12]), scoreThr: 0.6, nmsThr: 0.3, sx: input.sx, sy: input.sy)
        guard let f = FaceMath.largest(faces) else { return nil }
        let blob = FaceMath.alignedBlob(px, w, h, FaceMath.similarity(f.lm))
        return try sf.run(blob, shape: [1, 3, 112, 112])
    }

    // ---- the people Jarvis knows
    private func people() -> [[String: Any]] { (JSBridge.parse(d.string(forKey: "faces.people") ?? "[]") as? [[String: Any]]) ?? [] }
    private func save(_ a: [[String: Any]]) { d.set(JSBridge.json(a), forKey: "faces.people") }
    private static func key(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces).lowercased() }

    func remember(_ b64: String, name: String, title: String, done: @escaping (String) -> Void) {
        q.async { [self] in
            if !available { done("{\"ok\":false,\"error\":\"unavailable\"}"); return }
            do {
                guard let sig = try signature(b64) else { done("{\"ok\":false,\"error\":\"noface\"}"); return }
                var all: [[String: Any]] = people()
                let want = Faces.key(name)
                var idx: Int = -1
                for (k, p) in all.enumerated() where Faces.key((p["name"] as? String) ?? "") == want { idx = k; break }
                if idx < 0 {
                    let fresh: [String: Any] = ["name": name.trimmingCharacters(in: .whitespaces), "samples": [[Double]]()]
                    all.append(fresh); idx = all.count - 1
                }
                var person: [String: Any] = all[idx]
                let t = title.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { person["title"] = t }
                var samples: [[Double]] = (person["samples"] as? [[Double]]) ?? []
                let row: [Double] = sig.map { (Double($0) * 10000).rounded() / 10000 }
                samples.append(row)
                if samples.count > 5 { samples.removeFirst(samples.count - 5) }
                person["samples"] = samples
                all[idx] = person
                save(all)
                let out: [String: Any] = ["ok": true, "samples": samples.count]
                done(JSBridge.json(out))
            } catch { done(JSBridge.json(["ok": false, "error": error.localizedDescription])) }
        }
    }

    func identify(_ b64: String, done: @escaping (String) -> Void) {
        q.async { [self] in
            if !available { done("{\"ok\":false,\"error\":\"unavailable\"}"); return }
            do {
                guard let sig = try signature(b64) else { done("{\"ok\":true,\"face\":false}"); return }
                var best: [String: Any]? = nil
                var bestSim: Double = Faces.match
                for p in people() {
                    let samples: [[Double]] = (p["samples"] as? [[Double]]) ?? []
                    let who: String = (p["name"] as? String) ?? "", title: String = (p["title"] as? String) ?? ""
                    for v in samples {
                        let ref: [Float] = v.map { Float($0) }
                        let sim: Double = FaceMath.cosine(sig, ref)
                        if sim >= bestSim {
                            bestSim = sim
                            let entry: [String: Any] = ["name": who, "title": title, "similarity": (sim * 100).rounded() / 100]
                            best = entry
                        }
                    }
                }
                let match: Any = best ?? NSNull()
                let out: [String: Any] = ["ok": true, "face": true, "match": match]
                done(JSBridge.json(out))
            } catch { done(JSBridge.json(["ok": false, "error": error.localizedDescription])) }
        }
    }

    func list() -> String {
        var out: [[String: Any]] = []
        for p in people() {
            let n: Int = ((p["samples"] as? [Any]) ?? []).count
            let row: [String: Any] = ["name": (p["name"] as? String) ?? "", "title": (p["title"] as? String) ?? "", "samples": n]
            out.append(row)
        }
        return JSBridge.json(out)
    }

    func forget(_ name: String) -> Bool {
        let all = people(), k = Faces.key(name)
        let keep = all.filter { !(k == "everyone" || Faces.key(($0["name"] as? String) ?? "") == k) }
        save(keep)
        return keep.count != all.count
    }
}
