import AVFoundation
import JarvisCore
import OnnxRuntimeBindings

/// ONNX models on the phone (ONNX Runtime): the wake word, the speech detector and face recognition.
enum Ort {
    static let env: ORTEnv? = try? ORTEnv(loggingLevel: .warning)
    static func path(_ name: String) -> String? {
        guard let u = Bundle.main.resourceURL?.appendingPathComponent("models").appendingPathComponent(name) else { return nil }
        return FileManager.default.fileExists(atPath: u.path) ? u.path : nil
    }
}

final class OrtNet: OnnxNet {
    let session: ORTSession
    let input: String
    let outputs: [String]
    init(_ name: String, threads: Int32 = 1) throws {
        guard let env = Ort.env, let p = Ort.path(name) else { throw NSError(domain: "Ort", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing model \(name)"]) }
        let o = try ORTSessionOptions()
        try o.setIntraOpNumThreads(threads)
        session = try ORTSession(env: env, modelPath: p, sessionOptions: o)
        input = try session.inputNames()[0]
        outputs = try session.outputNames()
    }
    static func tensor(_ x: [Float], _ shape: [Int]) throws -> ORTValue {
        let data = x.withUnsafeBufferPointer { NSMutableData(bytes: $0.baseAddress, length: $0.count * MemoryLayout<Float>.size) }
        return try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
    }
    static func floats(_ v: ORTValue) throws -> [Float] {
        let d = try v.tensorData() as Data
        return d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }
    func runAll(_ x: [Float], shape: [Int]) throws -> [[Float]] {
        let res = try session.run(withInputs: [input: try OrtNet.tensor(x, shape)], outputNames: Set(outputs), runOptions: nil)
        return try outputs.map { name in
            guard let v = res[name] else { throw NSError(domain: "Ort", code: 2) }
            return try OrtNet.floats(v)
        }
    }
    func run(_ x: [Float], shape: [Int]) throws -> [Float] { try runAll(x, shape: shape)[0] }
}

final class OrtSilero: SileroNet {
    let session: ORTSession
    let outputs: [String]
    let sr: ORTValue
    init() throws {
        guard let env = Ort.env, let p = Ort.path("vad/silero_vad.onnx") else { throw NSError(domain: "Ort", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing silero"]) }
        let o = try ORTSessionOptions()
        try o.setIntraOpNumThreads(1)
        session = try ORTSession(env: env, modelPath: p, sessionOptions: o)
        outputs = try session.outputNames()
        var rate: Int64 = 16000
        sr = try ORTValue(tensorData: NSMutableData(bytes: &rate, length: 8), elementType: .int64, shape: [])
    }
    func run(_ input: [Float], state: [Float]) throws -> [Float] {
        let res = try session.run(withInputs: ["input": try OrtNet.tensor(input, [1, input.count]), "state": try OrtNet.tensor(state, [2, 1, 128]), "sr": sr],
                                  outputNames: Set(outputs), runOptions: nil)
        guard outputs.count >= 2, let p = res[outputs[0]], let st = res[outputs[1]] else { throw NSError(domain: "Ort", code: 3) }
        let prob = try OrtNet.floats(p), next = try OrtNet.floats(st)
        return [prob.first ?? 0] + next
    }
}

/// The phone's ears (port of VoiceEngine.java): records the microphone, listens for "Hey Jarvis" on the phone itself,
/// and passes audio to the page only while Jarvis is listening to you. Idle audio never leaves the phone.
final class Ears {
    var onWake: (Float) -> Void = { _ in }
    var onLevel: (Float, Float, Float) -> Void = { _, _, _ in }
    var onPcm: ([Int16], Float) -> Void = { _, _ in }
    var onState: (String) -> Void = { _ in }

    private let engine = AVAudioEngine()
    private let q = DispatchQueue(label: "jarvis.ears", qos: .userInteractive)
    private var wake: WakeWord?
    private var vad: SileroVad?
    private let gain = WakeWord.AutoGain(6)
    private(set) var wakeError = ""
    private(set) var running = false
    private var wanted = false
    private var listening = false, speaking = false, muted = false
    private var threshold: Float = 0.3, speakingThreshold: Float = 0.5
    private var preroll: [[Int16]] = [], prerollSpeech: [Float] = []
    private var pending: [Int16] = []
    private var lastWake = Date.distantPast
    private var n = 0, peakScore: Float = 0, peakSpeech: Float = -1
    private var modelsLoaded = false
    private var converter: AVAudioConverter?
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    var hasWake: Bool { wake != nil }
    var hasVad: Bool { vad != nil }

    init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .ended && self.wanted { self.restart() }
        }
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            if let s = self, s.wanted { s.restart() }
        }
    }

    private func loadModels() {
        if modelsLoaded { return }
        modelsLoaded = true
        do { wake = try WakeWord(mel: OrtNet("wake/melspectrogram.onnx"), emb: OrtNet("wake/embedding_model.onnx"), cls: OrtNet("wake/hey_jarvis.onnx")) }
        catch { wake = nil; wakeError = String(describing: error); NSLog("[JARVIS] wake word: %@", wakeError) }
        do { vad = SileroVad(try OrtSilero()) } catch { vad = nil; NSLog("[JARVIS] speech detector: %@", String(describing: error)) }
    }

    static var permission: AVAudioSession.RecordPermission { AVAudioSession.sharedInstance().recordPermission }

    /// "ok", "no-permission" or an error.
    func start() -> String {
        if Ears.permission != .granted { return "no-permission" }
        wanted = true
        if running { return "ok" }
        q.async { [weak self] in
            self?.loadModels()
            DispatchQueue.main.async { self?.startEngine() }
        }
        return "ok"
    }

    func stop() { wanted = false; stopEngine(); onState("stopped") }
    /// The app went to the background: the microphone is released (and comes back with the app).
    func pause() { if running { stopEngine(); onState("stopped") } }
    func resume() { if wanted && !running { startEngine() } }
    private func restart() { stopEngine(); if wanted { startEngine() } }

    private func startEngine() {
        guard !running else { return }
        AudioSessionKit.activate()
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) } catch { NSLog("[JARVIS] echo cancelling unavailable: %@", String(describing: error)) }
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { onState("error:microphone unavailable"); return }
        converter = AVAudioConverter(from: fmt, to: outFormat)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, _ in self?.convert(buf) }
        do {
            engine.prepare()
            try engine.start()
            running = true
            onState(wake != nil ? "listening" : "listening-no-wake:" + wakeError)
        } catch {
            input.removeTap(onBus: 0)
            onState("error:" + error.localizedDescription)
        }
    }

    private func stopEngine() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        running = false
    }

    private func convert(_ buf: AVAudioPCMBuffer) {
        guard let conv = converter else { return }
        let ratio = outFormat.sampleRate / buf.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * ratio + 64)) else { return }
        var given = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true; status.pointee = .haveData; return buf
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        q.async { [weak self] in self?.feed(samples) }
    }

    // ---- page controls (called on the main thread)
    func setListening(_ on: Bool, preroll withPreroll: Bool) {
        q.async { [self] in
            if on && !listening && withPreroll { for (i, c) in preroll.enumerated() { onPcm(c, i < prerollSpeech.count ? prerollSpeech[i] : -1) } }
            if on != listening { preroll.removeAll(); prerollSpeech.removeAll() }
            listening = on
        }
    }
    func setSpeaking(_ on: Bool) { q.async { self.speaking = on } }
    func setMuted(_ on: Bool) { q.async { self.muted = on } }
    func setThreshold(_ t: Float) { q.async { if t > 0.05 && t < 0.95 { self.threshold = t; self.speakingThreshold = max(t, min(0.9, t + 0.2)) } } }

    // ---- the listening loop (on q)
    private func feed(_ samples: [Int16]) {
        pending.append(contentsOf: samples)
        while pending.count >= WakeWord.chunk {
            let chunk = Array(pending.prefix(WakeWord.chunk))
            pending.removeFirst(WakeWord.chunk)
            process(chunk)
        }
    }

    private func process(_ chunk: [Int16]) {
        let rms = Pcm.rms(chunk)
        var score: Float = 0
        if let w = wake, !muted {
            score = (try? w.process(gain.apply(chunk))) ?? 0
            if score >= (speaking ? speakingThreshold : threshold) && Date().timeIntervalSince(lastWake) > 2 {
                lastWake = Date()
                onWake(score)
            }
        }
        peakScore = max(peakScore, score)
        var speech: Float = -1
        if let v = vad { speech = (try? v.process(chunk)) ?? -1 }
        peakSpeech = max(peakSpeech, speech)
        if listening && !muted { onPcm(chunk, speech) }
        else {
            preroll.append(chunk); prerollSpeech.append(speech)
            while preroll.count > 15 { preroll.removeFirst(); prerollSpeech.removeFirst() }
        }
        n += 1
        if n % 2 == 0 { onLevel(rms, peakScore, peakSpeech); peakScore = 0; peakSpeech = -1 }
    }
}
