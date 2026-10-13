import Foundation

/// One ONNX model: flat float input with a shape, flat float output.
public protocol OnnxNet {
    func run(_ input: [Float], shape: [Int]) throws -> [Float]
}

/// java.util.Random, bit for bit (the wake word's start-up noise is generated with it, as on Android).
public struct JavaRandom {
    private var seed: Int64
    private static let mask: Int64 = (1 << 48) - 1
    public init(_ s: Int64) { seed = (s ^ 0x5DEECE66D) & JavaRandom.mask }
    mutating func next(_ bits: Int) -> Int32 {
        seed = (seed &* 0x5DEECE66D &+ 0xB) & JavaRandom.mask
        return Int32(truncatingIfNeeded: seed >> Int64(48 - bits))
    }
    public mutating func nextInt(_ bound: Int32) -> Int32 {
        if (bound & -bound) == bound { return Int32(truncatingIfNeeded: (Int64(bound) &* Int64(next(31))) >> 31) }
        var bits: Int32, val: Int32
        repeat { bits = next(31); val = bits % bound } while bits &- val &+ (bound &- 1) < 0
        return val
    }
}

/// "Hey Jarvis" detector: the openWakeWord models and streaming steps the PC version uses (port of WakeWord.java).
/// Feed it 80 ms chunks (1280 samples, 16 kHz, 16-bit). Each chunk returns a score from 0 to 1.
public final class WakeWord {
    public static let chunk = 1280
    static let melCtx = chunk + 160 * 3, bins = 32, win = 76, emb = 96, feats = 16

    private let mel: OnnxNet, embNet: OnnxNet, cls: OnnxNet
    private var raw = [Int16](repeating: 0, count: melCtx)
    private var rawLen = 0
    private var melBuf: [[Float]] = []
    private var featBuf: [[Float]] = []
    private var predictions = 0

    public init(mel: OnnxNet, emb: OnnxNet, cls: OnnxNet, initialFeatures: [[Float]]? = nil) throws {
        self.mel = mel; self.embNet = emb; self.cls = cls
        for _ in 0..<WakeWord.win { melBuf.append([Float](repeating: 1, count: WakeWord.bins)) }
        let initial = try initialFeatures ?? noiseFeatures()
        for f in initial { pushFeature(f) }
    }

    /// Like openWakeWord's start-up: features of 4 s of quiet noise, so the first second never fires.
    private func noiseFeatures() throws -> [[Float]] {
        var rnd = JavaRandom(7)
        let n = 16000 * 4
        var x = [Float](repeating: 0, count: n)
        for i in 0..<n { x[i] = Float(rnd.nextInt(2000) - 1000) }
        let m = try mel.run(x, shape: [1, n])
        let frames = m.count / WakeWord.bins
        var out: [[Float]] = []
        var start = 0
        while start + WakeWord.win <= frames {
            var input = [Float](repeating: 0, count: WakeWord.win * WakeWord.bins)
            for t in 0..<WakeWord.win { for b in 0..<WakeWord.bins { input[t * WakeWord.bins + b] = m[(start + t) * WakeWord.bins + b] / 10 + 2 } }
            out.append(try embNet.run(input, shape: [1, WakeWord.win, WakeWord.bins, 1]))
            start += 8
        }
        return out
    }

    private func pushFeature(_ f: [Float]) {
        var c = [Float](repeating: 0, count: WakeWord.emb)
        for i in 0..<min(WakeWord.emb, f.count) { c[i] = f[i] }
        featBuf.append(c)
        while featBuf.count > WakeWord.feats { featBuf.removeFirst() }
    }

    /// One 80 ms chunk in, wake score out (0..1).
    public func process(_ chunk: [Int16]) throws -> Float {
        precondition(chunk.count == WakeWord.chunk, "chunk must be \(WakeWord.chunk) samples")
        if rawLen + WakeWord.chunk <= WakeWord.melCtx {
            for i in 0..<WakeWord.chunk { raw[rawLen + i] = chunk[i] }
            rawLen += WakeWord.chunk
        } else {
            let keep = WakeWord.melCtx - WakeWord.chunk
            let tail = Array(raw[(rawLen - keep)..<rawLen])
            for i in 0..<keep { raw[i] = tail[i] }
            for i in 0..<WakeWord.chunk { raw[keep + i] = chunk[i] }
            rawLen = WakeWord.melCtx
        }
        var x = [Float](repeating: 0, count: rawLen)
        for i in 0..<rawLen { x[i] = Float(raw[i]) }
        let m = try mel.run(x, shape: [1, rawLen])
        var t = 0
        while t + WakeWord.bins <= m.count {
            var row = [Float](repeating: 0, count: WakeWord.bins)
            for b in 0..<WakeWord.bins { row[b] = m[t + b] / 10 + 2 }
            melBuf.append(row)
            t += WakeWord.bins
        }
        while melBuf.count > WakeWord.win { melBuf.removeFirst() }

        var input = [Float](repeating: 0, count: WakeWord.win * WakeWord.bins)
        for (r, row) in melBuf.enumerated() { for b in 0..<WakeWord.bins { input[r * WakeWord.bins + b] = row[b] } }
        pushFeature(try embNet.run(input, shape: [1, WakeWord.win, WakeWord.bins, 1]))

        var f = [Float](repeating: 0, count: WakeWord.feats * WakeWord.emb)
        for (k, feat) in featBuf.enumerated() { for j in 0..<WakeWord.emb { f[k * WakeWord.emb + j] = feat[j] } }
        let score = try cls.run(f, shape: [1, WakeWord.feats, WakeWord.emb])[0]
        predictions += 1
        return predictions <= 5 ? 0 : score               // openWakeWord ignores the first five predictions
    }

    /// wake.py's auto-gain: lift a quiet voice toward a healthy level; leave room noise alone.
    public final class AutoGain {
        private var peak: Float = 0
        private let maxGain: Float
        public init(_ maxGain: Float) { self.maxGain = maxGain }
        /// Returns the boosted chunk, or nil when the chunk is used as it is.
        public func boosted(_ x: [Int16]) -> [Int16]? {
            var p: Float = 0
            for s in x { p = max(p, abs(Float(s))) }
            peak = max(p, peak * 0.97)
            if maxGain > 1 && peak > 250 && peak < 5000 {
                let g = min(maxGain, 6000 / peak)
                return x.map { v in Int16(max(-32768, min(32767, Float(v) * g)).rounded(.towardZero)) }
            }
            return nil
        }
        public func apply(_ x: [Int16]) -> [Int16] { boosted(x) ?? x }
    }
}

/// Speech detector: Silero VAD (MIT licence) with the official streaming steps (port of SileroVad.java).
/// Feed it any chunk size; it works in 512-sample frames with 64 samples of context.
public protocol SileroNet {
    /// input [1, 576] and state [2, 1, 128] in; [probability, new state x256] out.
    func run(_ input: [Float], state: [Float]) throws -> [Float]
}

public final class SileroVad {
    static let frame = 512, context = 64, stateSize = 2 * 128
    private let net: SileroNet
    private var state = [Float](repeating: 0, count: stateSize)
    private var ctx = [Float](repeating: 0, count: context)
    private var pending = [Float](repeating: 0, count: frame)
    private var pendingLen = 0
    private var last: Float = 0

    public init(_ net: SileroNet) { self.net = net }

    /// Feeds a chunk; returns the highest speech probability of the frames it completed (or the previous value).
    public func process(_ chunk: [Int16]) throws -> Float {
        var best: Float = -1
        for v in chunk {
            pending[pendingLen] = Float(v) / 32768
            pendingLen += 1
            if pendingLen == SileroVad.frame {
                let input = ctx + pending
                let out = try net.run(input, state: state)
                for i in 0..<SileroVad.stateSize { state[i] = out[1 + i] }
                ctx = Array(input[(input.count - SileroVad.context)...])
                pendingLen = 0
                best = max(best, out[0])
            }
        }
        if best >= 0 { last = best }
        return last
    }
}
