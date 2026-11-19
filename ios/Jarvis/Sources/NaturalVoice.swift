import AVFoundation
import Foundation

/// Jarvis's natural voice on the iPhone, the same as the Android app's:
/// - the natural voice online (Groq's Orpheus, through the Jarvis service), and
/// - a character's own voice ("be Ultron"): a voice from Fish Audio's library, spoken by Fish Audio with the user's key.
/// Every sentence is fetched as soon as the page writes it (prefetch), so the next one is ready when the last one ends.
/// It plays through one audio engine that sets the speed and pitch, and the mouth follows its real loudness.
/// When it can't (offline, the day's free allowance used up, a refused key), Apple's voice says the sentence instead.
final class NaturalVoice {
    // ---- settings from the page
    private var cloudUrl = "", cloudHeaders: [String: String] = [:], cloudVoice = ""
    private var fishKey = "", fishRef = ""
    private var speed: Float = 1.15, pitch: Float = 1
    private var cloudPausedUntil = Date.distantPast, fishPausedUntil = Date.distantPast
    private var note = "off"

    // ---- sentences: being fetched, waiting their turn, playing
    private final class Pending { var samples: [Float]?; var rate: Double = 24000; var failed = false; var waiters: [() -> Void] = [] }
    private var ready: [String: Pending] = [:]
    private var queue: [(id: Int, text: String)] = []
    private var playing: Int? = nil
    private var generation = 0                                            // stop() bumps it: late callbacks are ignored

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private var engineReady = false, wiredRate = 0.0
    private var env: [Float] = [], envHop = 256, envRate = 24000.0, startedAt = CFAbsoluteTimeGetCurrent()

    private let onEvent: (Int, String) -> Void
    private let fallback: (Int, String, @escaping () -> Void) -> Void    // Apple's voice says it; then the next sentence

    init(onEvent: @escaping (Int, String) -> Void, fallback: @escaping (Int, String, @escaping () -> Void) -> Void) {
        self.onEvent = onEvent
        self.fallback = fallback
    }

    // ================================================================== what the page sets
    func setCloud(url: String, headersJSON: String, voice: String) {
        let h = (JSBridge.parse(headersJSON) as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        if url != cloudUrl || voice != cloudVoice { ready.removeAll() }
        cloudUrl = url; cloudHeaders = h; cloudVoice = voice
        if url.isEmpty { note = "off" } else if note == "off" { note = "ok" }
    }
    func setFish(key: String, ref: String) {
        let k = key.trimmingCharacters(in: .whitespaces), r = ref.trimmingCharacters(in: .whitespaces)
        if k != fishKey || r != fishRef { ready.removeAll(); fishPausedUntil = .distantPast }
        fishKey = k; fishRef = r
    }
    func setSpeed(_ s: Double) { speed = Float(min(max(s, 0.6), 1.6)); timePitch.rate = speedNow }
    func setPitch(_ p: Double) { pitch = Float(min(max(p, 0.6), 1.6)); timePitch.pitch = 1200 * log2(pitch) }
    /** "ok", "off", or why it's resting ("quota:42" minutes, "refused", "fish-credits", ...). */
    func status() -> String { cloudOn ? "ok" : cloudUrl.isEmpty ? "off" : note }

    private var fishOn: Bool { !fishKey.isEmpty && !fishRef.isEmpty && Date() > fishPausedUntil }
    private var cloudOn: Bool { fishOn || (!cloudUrl.isEmpty && !cloudVoice.isEmpty && Date() > cloudPausedUntil) }
    private var speedNow: Float { fishOn ? 1 : speed }                     // a character speaks at their own pace
    /** True when the next sentence should be this voice (else Apple's). */
    func speaksNow() -> Bool { cloudOn }
    var isPlaying: Bool { playing != nil }

    // ================================================================== speaking
    func prefetch(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cloudOn, !t.isEmpty, ready[t] == nil else { return }
        let p = Pending(); ready[t] = p
        if ready.count > 40 { ready.removeAll(); ready[t] = p }
        let gen = generation, fish = fishOn
        Task.detached { [weak self] in
            guard let self else { return }
            var out: ([Float], Double)? = nil
            do { out = fish ? try await self.fetchFish(t) : try await self.fetchCloud(t) }
            catch { NSLog("[JARVIS] natural voice: %@", String(describing: error)) }
            await MainActor.run {
                guard gen == self.generation || self.ready[t] === p else { return }
                if let o = out { p.samples = o.0; p.rate = o.1 } else { p.failed = true }
                let w = p.waiters; p.waiters = []; w.forEach { $0() }
            }
        }
    }

    func speak(id: Int, text: String) {
        prefetch(text)
        queue.append((id: id, text: text))
        if playing == nil { next() }
    }

    func stop() {
        generation += 1
        let dropped = queue; queue.removeAll(); ready.removeAll()
        if let id = playing { playing = nil; onEvent(id, "done") }
        dropped.forEach { onEvent($0.id, "done") }
        if engineReady { player.stop() }
        env = []
    }

    /** How open the mouth is now, 0...1 (the sentence's real loudness where it is playing). */
    func level() -> Float {
        guard playing != nil, !env.isEmpty else { return 0 }
        let i = Int((CFAbsoluteTimeGetCurrent() - startedAt) * envRate * Double(speedNow) / Double(envHop))
        return i >= 0 && i < env.count ? env[i] : 0
    }

    private func next() {
        guard playing == nil, !queue.isEmpty else { return }
        let job = queue.removeFirst(); playing = job.id
        let t = job.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if ready[t] == nil { prefetch(t) }
        guard let p = ready[t] else { appleSays(job); return }               // not fetched (the voice went off meanwhile)
        let gen = generation
        let go = { [weak self] in
            guard let self, gen == self.generation, self.playing == job.id else { return }
            self.ready.removeValue(forKey: t)
            if let s = p.samples, !s.isEmpty { self.play(job.id, s, p.rate) }
            else if p.samples != nil { self.finished(job.id) }               // nothing to say (only a direction)
            else { self.appleSays(job) }
        }
        if p.samples != nil || p.failed { go() } else { p.waiters.append(go) }
    }

    private func appleSays(_ job: (id: Int, text: String)) {
        let gen = generation
        fallback(job.id, job.text) { [weak self] in
            guard let self, gen == self.generation, self.playing == job.id else { return }
            self.playing = nil; self.next()
        }
    }

    private func finished(_ id: Int) {
        guard playing == id else { return }
        playing = nil; env = []
        onEvent(id, "done")
        next()
    }

    private func play(_ id: Int, _ samples: [Float], _ rate: Double) {
        AudioSessionKit.activate()
        if !engineReady {
            engine.attach(player); engine.attach(timePitch)
            engineReady = true
        }
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(samples.count)) else { appleSays((id: id, text: "")); return }
        buf.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: samples.count) }
        if wiredRate != rate {                                              // (re)wire only when the sound's rate changes
            if engine.isRunning { player.stop(); engine.stop() }
            engine.disconnectNodeOutput(player); engine.disconnectNodeOutput(timePitch)
            engine.connect(player, to: timePitch, format: fmt)
            engine.connect(timePitch, to: engine.mainMixerNode, format: fmt)
            wiredRate = rate
        }
        timePitch.rate = speedNow; timePitch.pitch = 1200 * log2(pitch)
        do { if !engine.isRunning { try engine.start() } } catch {
            NSLog("[JARVIS] audio engine: %@", String(describing: error)); finished(id); return
        }
        // the mouth: loudness every 256 samples, scaled like the Android app's
        var e: [Float] = []; e.reserveCapacity(samples.count / envHop + 1)
        var peak: Float = 0.0001
        var i = 0
        while i < samples.count {
            let end = min(i + envHop, samples.count); var sum: Float = 0
            for j in i..<end { sum += samples[j] * samples[j] }
            let r = (sum / Float(end - i)).squareRoot(); e.append(r); peak = max(peak, r); i = end
        }
        env = e.map { min(1, $0 / (peak * 0.8)) }; envRate = rate
        let gen = generation
        player.stop()
        player.scheduleBuffer(buf, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { guard let self, gen == self.generation else { return }; self.finished(id) }
        }
        startedAt = CFAbsoluteTimeGetCurrent()
        player.play()
    }

    // ================================================================== fetching
    private func fetchCloud(_ text: String) async throws -> ([Float], Double) {
        // Groq takes up to 200 characters a request: a long sentence goes in pieces cut at commas or spaces
        var parts: [String] = [], rest = text
        while rest.count > 190 {
            let head = String(rest.prefix(190))
            var cut = max(head.range(of: ", ", options: .backwards)?.lowerBound.utf16Offset(in: head) ?? -1,
                          head.range(of: "; ", options: .backwards)?.lowerBound.utf16Offset(in: head) ?? -1)
            if cut < 60 { cut = head.range(of: " ", options: .backwards)?.lowerBound.utf16Offset(in: head) ?? 190 }
            if cut < 1 { cut = 190 }
            let idx = rest.index(rest.startIndex, offsetBy: min(cut + 1, rest.count))
            parts.append(String(rest[..<idx]).trimmingCharacters(in: .whitespaces)); rest = String(rest[idx...]).trimmingCharacters(in: .whitespaces)
        }
        if !rest.isEmpty { parts.append(rest) }
        var all: [Float] = [], rate = 24000.0
        for part in parts {
            let said = SpokenText.cloud(part)
            if said.isEmpty { continue }
            guard let url = URL(string: cloudUrl) else { throw NSError(domain: "speech", code: -1) }
            var req = URLRequest(url: url, timeoutInterval: 20)
            req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            cloudHeaders.forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
            req.httpBody = try JSONSerialization.data(withJSONObject: ["model": "canopylabs/orpheus-v1-english", "voice": cloudVoice, "input": said, "response_format": "wav"])
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 {
                let err = String(data: data.prefix(2048), encoding: .utf8) ?? ""
                await MainActor.run {
                    if code == 429 {                                         // the day's free allowance: wait until Groq says it resets
                        var mins = 15.0
                        if let m = err.range(of: #"try again in (?:(\d+)h)?(?:(\d+)m)?"#, options: .regularExpression) {
                            let s = String(err[m]); let h = Double(s.firstMatch(#"(\d+)h"#) ?? "0") ?? 0, mm = Double(s.firstMatch(#"(\d+)m"#) ?? "0") ?? 0
                            mins = h * 60 + mm + 1
                        }
                        self.cloudPausedUntil = Date().addingTimeInterval(mins * 60); self.note = "quota:\(Int(mins))"
                    } else if code == 401 || code == 403 || err.contains("terms") {
                        self.cloudPausedUntil = Date().addingTimeInterval(600); self.note = "refused"
                    }
                }
                throw NSError(domain: "speech", code: code, userInfo: [NSLocalizedDescriptionKey: err])
            }
            let w = try Wav.decode(data); all += w.0; rate = w.1
        }
        return (Wav.trim(all, rate), rate)
    }

    private func fetchFish(_ text: String) async throws -> ([Float], Double) {
        let said = SpokenText.offline(text)                                  // no "[warm]" read out
        if said.isEmpty { return ([], 24000) }
        var req = URLRequest(url: URL(string: "https://api.fish.audio/v1/tts")!, timeoutInterval: 25)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(fishKey)", forHTTPHeaderField: "Authorization")
        req.setValue("s2.1-pro-free", forHTTPHeaderField: "model")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["text": said, "reference_id": fishRef, "format": "wav", "sample_rate": 24000, "latency": "balanced"])
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code != 200 {
            // 401 wrong key, 402 no free use left, 429 too many: Jarvis's own voice for a while, then try again
            if [401, 402, 403, 429].contains(code) {
                await MainActor.run {
                    self.fishPausedUntil = Date().addingTimeInterval(code == 429 ? 120 : 600)
                    self.note = code == 402 ? "fish-credits" : code == 429 ? "fish-busy" : "fish-key"
                }
            }
            throw NSError(domain: "fish", code: code, userInfo: [NSLocalizedDescriptionKey: String(data: data.prefix(1024), encoding: .utf8) ?? ""])
        }
        let w = try Wav.decode(data)
        return (Wav.trim(w.0, w.1), w.1)
    }
}

private extension String {
    func firstMatch(_ pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: self, range: NSRange(startIndex..., in: self)), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: self) else { return nil }
        return String(self[r])
    }
}

/// WAV bytes to mono float samples (16-bit or 32-bit float), the same as the Android app's Wav.decode. A streamed WAV's
/// sizes can be left unset (0 or 0xFFFFFFFF): then everything after the data header is the sound.
enum Wav {
    static func decode(_ d: Data) throws -> ([Float], Double) {
        let b = [UInt8](d)
        func u32(_ i: Int) -> Int { i + 4 <= b.count ? Int(UInt32(b[i]) | UInt32(b[i+1]) << 8 | UInt32(b[i+2]) << 16 | UInt32(b[i+3]) << 24) : 0 }
        func u16(_ i: Int) -> Int { i + 2 <= b.count ? Int(UInt16(b[i]) | UInt16(b[i+1]) << 8) : 0 }
        guard b.count > 44, String(bytes: b[0..<4], encoding: .ascii) == "RIFF" else { throw NSError(domain: "wav", code: 1) }
        var i = 12, rate = 24000, ch = 1, bits = 16, fmtTag = 1
        while i + 8 <= b.count {
            let id = String(bytes: b[i..<i+4], encoding: .ascii) ?? "", size = u32(i + 4)
            if id == "fmt " { fmtTag = u16(i + 8); ch = max(1, u16(i + 10)); rate = u32(i + 12); bits = u16(i + 22) }
            if id == "data" {
                let start = i + 8, end = (size == 0 || size == 0xFFFFFFFF || start + size > b.count) ? b.count : start + size
                let step = bits / 8 * ch; var out: [Float] = []; out.reserveCapacity((end - start) / max(1, step))
                var j = start
                while j + step <= end {
                    if fmtTag == 3 && bits == 32 {
                        out.append(Float(bitPattern: UInt32(u32(j))))
                    } else {
                        out.append(Float(Int16(bitPattern: UInt16(u16(j)))) / 32768)
                    }
                    j += step
                }
                return (out, Double(rate))
            }
            i += 8 + size + (size & 1)
            if size <= 0 { break }
        }
        throw NSError(domain: "wav", code: 2)
    }
    /** Cuts the silence at both ends (keeps 40 ms). */
    static func trim(_ s: [Float], _ rate: Double) -> [Float] {
        guard !s.isEmpty else { return s }
        let thr: Float = 0.01, keep = Int(rate * 0.04)
        guard let a = s.firstIndex(where: { abs($0) > thr }), let z = s.lastIndex(where: { abs($0) > thr }) else { return [] }
        return Array(s[max(0, a - keep)...min(s.count - 1, z + keep)])
    }
}

/// Spoken sounds and stage directions, made right for each voice (the same rules as the Android app's SpokenText).
enum SpokenText {
    private static func re(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: o) }
    private static let direction = re(#"\[([A-Za-z][A-Za-z \-]{1,28})\]\s*"#)
    private static let stage = re(#"[*(]\s*(laughs?|laughing|chuckles?|chuckling|giggles?|sighs?|sighing|smiles?|grins?)\s*[*)]\s*"#, .caseInsensitive)
    private static let agree = re(#"\b(?:[Mm]-?hm+|[Mm]m-hm+|[Mm]hmm|[Uu]h-hm+)\b"#)
    private static let hm = re(#"\b[Hh]m+\b"#)
    private static let mm = re(#"\b[Mm]{2,}\b"#)
    private static let noSound = re(#"\b(?:[Pp]ff+t?|[Pp]sh+|[Tt]sk)\b[,.!]?\s*"#)
    private static func sub(_ r: NSRegularExpression, _ s: String, _ with: String) -> String {
        r.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: NSRegularExpression.escapedTemplate(for: with))
    }
    private static func stages(_ s: String, _ f: (String) -> String) -> String {
        var out = "", last = s.startIndex
        for m in stage.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            guard let all = Range(m.range, in: s), let w = Range(m.range(at: 1), in: s) else { continue }
            out += s[last..<all.lowerBound]; out += f(s[w].lowercased()); last = all.upperBound
        }
        return out + s[last...]
    }
    private static func tidy(_ s: String) -> String {
        s.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /** For the cloud voice: keeps directions, turns "(laughs)" into one it acts. */
    static func cloud(_ text: String) -> String {
        var t = stages(text) { w in
            "[" + (w.hasPrefix("laug") ? "laughing" : w.hasPrefix("chuc") ? "chuckling" : w.hasPrefix("gigg") ? "giggling" : w.hasPrefix("sigh") ? "sigh" : "warm") + "] "
        }
        t = sub(agree, t, "\u{1}"); t = sub(hm, t, "Hmm"); t = sub(mm, t, "Mmm")
        return tidy(t.replacingOccurrences(of: "\u{1}", with: "Mm-hmm"))
    }
    /** For voices that read directions aloud: no directions, sounds spelled so they're said, not spelled out. */
    static func offline(_ text: String) -> String {
        var t = stages(text) { w in w.hasPrefix("laug") || w.hasPrefix("chuc") || w.hasPrefix("gigg") ? "Ha! " : "" }
        t = sub(direction, t, ""); t = sub(agree, t, "\u{1}"); t = sub(hm, t, "Hmm"); t = sub(mm, t, "Hmm"); t = sub(noSound, t, "")
        return tidy(t.replacingOccurrences(of: "\u{1}", with: "Hmm-hmm"))
    }
}
