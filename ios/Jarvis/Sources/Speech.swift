import AVFoundation

/// One audio setup for listening and talking at the same time: Jarvis's voice comes out of the loudspeaker (or the car
/// over Bluetooth), music keeps playing underneath, and the microphone stays open for "Hey Jarvis".
enum AudioSessionKit {
    static func activate() {
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers])
            try s.setActive(true)
        } catch { NSLog("[JARVIS] audio session: %@", String(describing: error)) }
    }
}

/// Jarvis's voice: Apple's built-in voices (download the Enhanced or Premium ones in Settings for the best sound).
final class Speech: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var ids: [ObjectIdentifier: Int] = [:]
    private var voiceId = ""
    private let onEvent: (Int, String) -> Void

    init(onEvent: @escaping (Int, String) -> Void) {
        self.onEvent = onEvent
        super.init()
        synth.delegate = self
    }

    private func voice(lang: String?) -> AVSpeechSynthesisVoice? {
        if let l = lang, !l.isEmpty {
            let want = l.lowercased(), base = String(want.prefix(2))
            let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.lowercased() == want || $0.language.lowercased().hasPrefix(base) }
            return all.sorted { $0.quality.rawValue > $1.quality.rawValue }.first ?? AVSpeechSynthesisVoice(language: l)
        }
        if !voiceId.isEmpty, let v = AVSpeechSynthesisVoice(identifier: voiceId) { return v }
        return Speech.best(gender: nil)
    }

    /// The best English voice of a gender (Enhanced/Premium first; British male, American female, like the Android app).
    static func best(gender: AVSpeechSynthesisVoiceGender?) -> AVSpeechSynthesisVoice? {
        let en = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") && !isNovelty($0) }
        let ranked = en.sorted { a, b in
            func score(_ v: AVSpeechSynthesisVoice) -> Int {
                var s = v.quality.rawValue * 10
                if let g = gender, v.gender == g { s += 100 }
                if v.language == (gender == .female ? "en-US" : "en-GB") { s += 5 }
                return s
            }
            return score(a) > score(b)
        }
        return ranked.first ?? AVSpeechSynthesisVoice(language: "en-GB")
    }

    static func isNovelty(_ v: AVSpeechSynthesisVoice) -> Bool {
        if #available(iOS 17.0, *) { if v.voiceTraits.contains(.isNoveltyVoice) || v.voiceTraits.contains(.isPersonalVoice) { return true } }
        return v.identifier.contains("eloquence") || v.identifier.contains("speech.synthesis.voice")
    }

    func speak(id: Int, text: String, rate: Double, pitch: Double, lang: String? = nil) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { onEvent(id, "done"); return }
        AudioSessionKit.activate()
        let u = AVSpeechUtterance(string: t)
        u.voice = voice(lang: lang)
        let base = Double(AVSpeechUtteranceDefaultSpeechRate)
        u.rate = Float(min(max(base * (1 + (rate - 1) * 0.6), Double(AVSpeechUtteranceMinimumSpeechRate)), Double(AVSpeechUtteranceMaximumSpeechRate)))
        u.pitchMultiplier = Float(min(max(pitch, 0.5), 2.0))
        u.preUtteranceDelay = 0
        ids[ObjectIdentifier(u)] = id
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
    func setVoice(_ id: String) { voiceId = id }

    /// [{id, label, lang}] — the label says male/female so the page can match voices to Jarvis's face.
    func voicesJSON() -> String {
        let mine = String((Locale.preferredLanguages.first ?? "en").prefix(2))
        let list = AVSpeechSynthesisVoice.speechVoices().filter { ($0.language.hasPrefix("en") || $0.language.hasPrefix(mine)) && !Speech.isNovelty($0) }
            .sorted { ($0.quality.rawValue, $0.name) > ($1.quality.rawValue, $1.name) }
        let out: [[String: String]] = list.prefix(40).map { v in
            let q = v.quality == .premium ? "Premium" : v.quality == .enhanced ? "Enhanced" : "Standard"
            let g = v.gender == .male ? "male" : v.gender == .female ? "female" : ""
            return ["id": v.identifier, "label": "\(v.name) · \(q)\(g.isEmpty ? "" : " · " + g)", "lang": v.language]
        }
        return JSBridge.json(out)
    }

    /// 1: this iPhone can speak the language now, 0: a voice needs downloading in Settings, -1: no voice at all.
    func langAvailable(_ lang: String) -> Int {
        let base = String(lang.lowercased().prefix(2))
        return AVSpeechSynthesisVoice.speechVoices().contains { $0.language.lowercased().hasPrefix(base) } ? 1 : -1
    }

    // ---- delegate
    private func finished(_ u: AVSpeechUtterance, _ ev: String) {
        if let id = ids.removeValue(forKey: ObjectIdentifier(u)) { onEvent(id, ev) }
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { finished(u, "done") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { finished(u, "done") }
}

/// Short chimes (wake, end of session, timers).
final class Tone {
    private var players: [AVAudioPlayer] = []
    func play(freq: Double, ms: Int, volume: Double) {
        let rate = 22050, n = max(1, min(rate, rate * max(20, ms) / 1000))
        let vol = max(0.02, min(1.0, volume * 6.0))
        var pcm = [Int16](repeating: 0, count: n)
        for i in 0..<n {
            let env = min(1.0, min(Double(i) / (Double(rate) * 0.005), Double(n - i) / (Double(rate) * 0.03)))
            pcm[i] = Int16(sin(2 * Double.pi * freq * Double(i) / Double(rate)) * env * vol * 32767)
        }
        var wav = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 2)) }
        wav.append(Data("RIFF".utf8)); u32(UInt32(36 + n * 2)); wav.append(Data("WAVEfmt ".utf8))
        u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        wav.append(Data("data".utf8)); u32(UInt32(n * 2))
        pcm.withUnsafeBufferPointer { wav.append(Data(buffer: $0)) }
        AudioSessionKit.activate()
        guard let p = try? AVAudioPlayer(data: wav) else { return }
        players.append(p)
        p.play()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms + 200)) { [weak self] in self?.players.removeAll { $0 === p } }
    }
}
