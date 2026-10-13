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
                var all = people()
                var i = all.firstIndex { Faces.key(($0["name"] as? String) ?? "") == Faces.key(name) }
                if i == nil { all.append(["name": name.trimmingCharacters(in: .whitespaces), "samples": [[Double]]()]); i = all.count - 1 }
                if !title.trimmingCharacters(in: .whitespaces).isEmpty { all[i!]["title"] = title.trimmingCharacters(in: .whitespaces) }
                var s = (all[i!]["samples"] as? [[Double]]) ?? []
                s.append(sig.map { (Double($0) * 10000).rounded() / 10000 })
                if s.count > 5 { s.removeFirst(s.count - 5) }
                all[i!]["samples"] = s
                save(all)
                done(JSBridge.json(["ok": true, "samples": s.count]))
            } catch { done(JSBridge.json(["ok": false, "error": error.localizedDescription])) }
        }
    }

    func identify(_ b64: String, done: @escaping (String) -> Void) {
        q.async { [self] in
            if !available { done("{\"ok\":false,\"error\":\"unavailable\"}"); return }
            do {
                guard let sig = try signature(b64) else { done("{\"ok\":true,\"face\":false}"); return }
                var best: [String: Any]? = nil, bestSim = Faces.match
                for p in people() {
                    for v in (p["samples"] as? [[Double]]) ?? [] {
                        let sim = FaceMath.cosine(sig, v.map { Float($0) })
                        if sim >= bestSim { bestSim = sim; best = ["name": p["name"] ?? "", "title": p["title"] ?? "", "similarity": (sim * 100).rounded() / 100] }
                    }
                }
                done(JSBridge.json(["ok": true, "face": true, "match": best ?? NSNull()]))
            } catch { done(JSBridge.json(["ok": false, "error": error.localizedDescription])) }
        }
    }

    func list() -> String {
        JSBridge.json(people().map { ["name": $0["name"] ?? "", "title": $0["title"] ?? "", "samples": (($0["samples"] as? [Any]) ?? []).count] })
    }

    func forget(_ name: String) -> Bool {
        let all = people(), k = Faces.key(name)
        let keep = all.filter { !(k == "everyone" || Faces.key(($0["name"] as? String) ?? "") == k) }
        save(keep)
        return keep.count != all.count
    }
}
