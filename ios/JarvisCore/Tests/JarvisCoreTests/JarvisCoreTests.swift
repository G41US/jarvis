import XCTest
@testable import JarvisCore

/// The same checks the Android versions pass (tests/face, tests/wake), replayed through the Swift ports.
final class JarvisCoreTests: XCTestCase {
    /// ios/JarvisCore/Tests/JarvisCoreTests/<this file> -> the repository root.
    static let root: URL = {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { u.deleteLastPathComponent() }
        return u
    }()

    // ------------------------------------------------------------------ "Hey Jarvis"
    final class Replay {
        var mdl: [String] = [], n: [Int] = [], sum: [Double] = [], first: [Double] = [], last: [Double] = [], out: [[Float]] = []
        var pos = 0
    }
    struct Recorded: OnnxNet {
        let tag: String, r: Replay
        func run(_ input: [Float], shape: [Int]) throws -> [Float] {
            let i = r.pos; r.pos += 1
            XCTAssertEqual(r.mdl[i], tag, "call \(i): wrong model")
            XCTAssertEqual(input.count, r.n[i], "call \(i) (\(tag)): size")
            XCTAssertEqual(shape.reduce(1, *), r.n[i], "call \(i) (\(tag)): shape")
            let s = input.reduce(0.0) { $0 + Double($1) }
            XCTAssertLessThanOrEqual(abs(s - r.sum[i]), 1e-3 * max(1, abs(r.sum[i])), "call \(i) (\(tag)): input sum \(s) vs \(r.sum[i])")
            XCTAssertLessThanOrEqual(abs(Double(input[0]) - r.first[i]), 1e-5, "call \(i): first value")
            XCTAssertLessThanOrEqual(abs(Double(input[input.count - 1]) - r.last[i]), 1e-5, "call \(i): last value")
            return r.out[i]
        }
    }

    func tokens(_ path: String) throws -> [Substring] {
        let text = try String(contentsOf: JarvisCoreTests.root.appendingPathComponent(path), encoding: .utf8)
        return text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\r" || $0 == "\t" })
    }

    func testWakeWordMatchesOpenWakeWord() throws {
        let t = try tokens("tests/wake/trace.txt"); var p = 0
        func int() -> Int { defer { p += 1 }; return Int(t[p])! }
        func dbl() -> Double { defer { p += 1 }; return Double(t[p])! }
        func str() -> String { defer { p += 1 }; return String(t[p]) }
        let fr = int(), fd = int()
        var initial: [[Float]] = []
        for _ in 0..<fr { initial.append((0..<fd).map { _ in Float(dbl()) }) }
        let nc = int()
        var chunks: [[Int16]] = []
        for _ in 0..<nc { chunks.append((0..<1280).map { _ in Int16(int()) }) }
        let calls = int(), r = Replay()
        for _ in 0..<calls {
            r.mdl.append(str()); r.n.append(int()); r.sum.append(dbl()); r.first.append(dbl()); r.last.append(dbl())
            let k = int(); r.out.append((0..<k).map { _ in Float(dbl()) })
        }
        let want = (0..<nc).map { _ in dbl() }
        let w = try WakeWord(mel: Recorded(tag: "mel", r: r), emb: Recorded(tag: "emb", r: r), cls: Recorded(tag: "hey", r: r), initialFeatures: initial)
        var worst = 0.0
        for i in 0..<nc { worst = max(worst, abs(Double(try w.process(chunks[i])) - want[i])) }
        XCTAssertEqual(r.pos, calls, "every recorded model call replayed")
        XCTAssertLessThanOrEqual(worst, 1e-6, "scores match")

        let g = WakeWord.AutoGain(6)
        let quiet = (0..<1280).map { Int16(sin(Double($0) / 5) * 1000) }
        let pk = g.apply(quiet).map { abs(Int($0)) }.max()!
        XCTAssertTrue(pk > 5000 && pk <= 6000, "a quiet voice is lifted (peak \(pk))")
        let hiss = (0..<1280).map { Int16(($0 % 7) * 20 - 60) }
        XCTAssertNil(WakeWord.AutoGain(6).boosted(hiss), "room hiss is left alone")
    }

    func testJavaRandomIsJavas() {
        var r = JavaRandom(7)                                      // java: new Random(7).nextInt(2000) x3
        XCTAssertEqual([r.nextInt(2000), r.nextInt(2000), r.nextInt(2000), r.nextInt(1024)], [236, 1164, 1485, 9])
    }

    func testSileroMatchesOfficialRun() throws {
        let t = try tokens("tests/wake/vad_trace.txt"); var p = 0
        func int() -> Int { defer { p += 1 }; return Int(t[p])! }
        func dbl() -> Double { defer { p += 1 }; return Double(t[p])! }
        let nc = int()
        var chunks: [[Int16]] = []
        for _ in 0..<nc { chunks.append((0..<1280).map { _ in Int16(int()) }) }
        let calls = int()
        var inSum: [Double] = [], stSum: [Double] = [], out: [[Float]] = []
        for _ in 0..<calls { inSum.append(dbl()); stSum.append(dbl()); let k = int(); out.append((0..<k).map { _ in Float(dbl()) }) }
        let want = (0..<nc).map { _ in dbl() }
        final class Box { var pos = 0 }
        struct Net: SileroNet {
            let b: Box, inSum: [Double], stSum: [Double], out: [[Float]]
            func run(_ input: [Float], state: [Float]) throws -> [Float] {
                let i = b.pos; b.pos += 1
                XCTAssertEqual(input.count, 576); XCTAssertEqual(state.count, 256)
                XCTAssertLessThanOrEqual(abs(input.reduce(0.0) { $0 + Double($1) } - inSum[i]), 1e-3, "frame \(i) input")
                XCTAssertLessThanOrEqual(abs(state.reduce(0.0) { $0 + Double($1) } - stSum[i]), 1e-3, "frame \(i) state")
                return out[i]
            }
        }
        let box = Box(), vad = SileroVad(Net(b: box, inSum: inSum, stSum: stSum, out: out))
        var worst = 0.0
        for i in 0..<nc { worst = max(worst, abs(Double(try vad.process(chunks[i])) - want[i])) }
        XCTAssertEqual(box.pos, calls)
        XCTAssertLessThanOrEqual(worst, 1e-6)
    }

    // ------------------------------------------------------------------ faces
    func testFaceMathMatchesReference() throws {
        let dir = JarvisCoreTests.root.appendingPathComponent("tests/face")
        let bin = try Data(contentsOf: dir.appendingPathComponent("trace.bin"))
        var off = 0
        func i32() -> Int { let v = bin.subdata(in: off..<off + 4).withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }; off += 4; return Int(Int32(littleEndian: v)) }
        func f32() -> Float { let v = bin.subdata(in: off..<off + 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }; off += 4; return Float(bitPattern: UInt32(littleEndian: v)) }
        let w = i32(), h = i32()
        var rgb = [UInt32](repeating: 0, count: w * h)
        bin.withUnsafeBytes { raw in
            for i in 0..<(w * h) { rgb[i] = (UInt32(raw[off + 3 * i]) << 16) | (UInt32(raw[off + 3 * i + 1]) << 8) | UInt32(raw[off + 3 * i + 2]) }
        }
        off += 3 * w * h
        var o = [[[Float]]](repeating: [[], [], []], count: 4)
        for k in 0..<4 { for s in 0..<3 { let n = i32(); o[k][s] = (0..<n).map { _ in f32() } } }

        var ex: [String: String] = [:], faceLines: [String] = []
        for line in try String(contentsOf: dir.appendingPathComponent("expected.txt"), encoding: .utf8).split(separator: "\n") {
            guard let sp = line.firstIndex(of: " ") else { continue }
            let k = String(line[..<sp]), v = String(line[line.index(after: sp)...])
            if k == "face" { faceLines.append(v) } else { ex[k] = v }
        }
        let nums = { (s: String) in s.split(separator: " ").map { Double($0)! } }
        let samples = { (s: String) in s.split(separator: " ").map { p -> (Int, Double) in let kv = p.split(separator: ":"); return (Int(kv[0])!, Double(kv[1])!) } }

        let input = FaceMath.letterbox(rgb, w, h)
        let sc = nums(ex["scale"]!)
        XCTAssertEqual(Double(input.sx), sc[0], accuracy: 1e-6); XCTAssertEqual(Double(input.sy), sc[1], accuracy: 1e-6)
        let sum = input.blob.reduce(0.0) { $0 + Double($1) }, want = Double(ex["blob_sum"]!)!
        XCTAssertLessThan(abs(sum - want) / want, 1e-6, "letterbox pixels (sum)")
        XCTAssertLessThan(samples(ex["blob"]!).map { abs(Double(input.blob[$0.0]) - $0.1) }.max()!, 2e-3, "letterbox samples")

        let faces = FaceMath.decode(cls: o[0], obj: o[1], bbox: o[2], kps: o[3], scoreThr: 0.6, nmsThr: 0.3, sx: input.sx, sy: input.sy)
        XCTAssertEqual(faces.count, Int(ex["faces"]!)!)
        guard let f = faces.first else { return }
        let e = nums(faceLines[0])
        let got: [Float] = [f.x, f.y, f.w, f.h] + f.lm + [f.score]
        XCTAssertLessThan((0..<15).map { abs(Double(got[$0]) - e[$0]) }.max()!, 1e-3, "face box, landmarks, score")
        let m = FaceMath.similarity(f.lm), em = nums(ex["M"]!)
        XCTAssertLessThan((0..<6).map { abs(m[$0] - em[$0]) }.max()!, 1e-4, "alignment matrix")
        let al = FaceMath.alignedBlob(rgb, w, h, m)
        let asum = al.reduce(0.0) { $0 + Double($1) }, aw = Double(ex["aligned_sum"]!)!
        XCTAssertLessThan(abs(asum - aw) / aw, 1e-5, "aligned face (sum)")
        XCTAssertLessThan(samples(ex["aligned"]!).map { abs(Double(al[$0.0]) - $0.1) }.max()!, 0.02, "aligned samples")
        XCTAssertEqual(FaceMath.cosine([1, 2, 3], [2, 4, 6]), 1, accuracy: 1e-9)
        XCTAssertEqual(FaceMath.cosine([1, 2, 3], [3, -1.5, 0]), 0, accuracy: 1e-9)
    }

    // ------------------------------------------------------------------ documents
    func testZipAndDocx() {
        XCTAssertEqual(CRC32.of(Data("123456789".utf8)), 0xCBF43926)
        let d = Docx.make(title: "Shift report", body: "Line one\nTom & Jerry <3")
        XCTAssertEqual(Array(d.prefix(4)), [0x50, 0x4b, 0x03, 0x04], "a zip")
        XCTAssertEqual(Array(d.suffix(22).prefix(4)), [0x50, 0x4b, 0x05, 0x06], "with an end record")
        let text = String(decoding: d, as: UTF8.self)
        XCTAssertTrue(text.contains("Tom &amp; Jerry &lt;3"))
        XCTAssertTrue(text.contains("word/document.xml"))
    }
}
