import UIKit
import AVFoundation
import Contacts
import EventKit
import MessageUI
import MediaPlayer
import Network
import UserNotifications

/// Everything the page asks the phone for. The method names, arguments and answers are the Android app's
/// (AndroidBridge = "B", AndroidPhone = "P"), so the page doesn't need to know which phone it is on.
final class Native: NSObject, MFMessageComposeViewControllerDelegate {
    let bridge: JSBridge
    let speech: Speech
    let ears = Ears()
    let tone = Tone()
    let http: Http
    let location: Location
    let reminders = Reminders()
    let faces = Faces()
    let docs = Docs()
    private let contacts = CNContactStore()
    private let events = EKEventStore()
    private let path = NWPathMonitor()
    private var net: NWPath?
    private var notifOK = false
    var presenter: () -> UIViewController? = { nil }
    var visible: Bool { UIApplication.shared.applicationState == .active }

    init(bridge: JSBridge) {
        self.bridge = bridge
        speech = Speech { id, ev in bridge.js("window.__ttsEvent&&window.__ttsEvent(\(id),'\(ev)')") }
        http = Http(bridge: bridge)
        location = Location(bridge: bridge)
        super.init()
        path.pathUpdateHandler = { [weak self] p in self?.net = p }
        path.start(queue: DispatchQueue(label: "jarvis.net"))
        UIDevice.current.isBatteryMonitoringEnabled = true
        ears.onWake = { s in bridge.js("window.__jvWake&&window.__jvWake(\(s))") }
        ears.onLevel = { rms, score, speech in bridge.js("window.__jvLevel&&window.__jvLevel(\(Int(rms.rounded())),\(score),\(speech))") }
        ears.onPcm = { pcm, speech in bridge.js("window.__jvPcm&&window.__jvPcm('\(Pcm.bytes(pcm).base64EncodedString())',\(speech))") }
        ears.onState = { st in bridge.js("window.__jvMic&&window.__jvMic(\(JSBridge.q(st)))") }
        reminders.onFire = { item, vis in bridge.js("window.__jvAlarm&&window.__jvAlarm(\(JSBridge.q(item)),\(vis))") }
        docs.presenter = { [weak self] in self?.presenter() }
        location.onAuth = { bridge.js("window.__jvPerm&&window.__jvPerm()") }
        refreshNotif()
        register()
    }

    func refreshNotif() { reminders.authorized { [weak self] ok in self?.notifOK = ok } }

    // ================================================================== registration
    private func register() {
        let b = bridge
        // ---- AndroidBridge: voice, microphone, web, opening things
        b.on("B", "ttsSpeak") { [self] a in speech.speak(id: a.n(0), text: a.s(1), rate: a.d(2), pitch: a.d(3)); return nil }
        b.on("B", "ttsSpeakLang") { [self] a in speech.speak(id: a.n(0), text: a.s(1), rate: a.d(2), pitch: a.d(3), lang: a.s(4)); return nil }
        b.on("B", "ttsLangAvailable") { [self] a in speech.langAvailable(a.s(0)) }
        b.on("B", "ttsStop") { [self] _ in speech.stop(); return nil }
        b.on("B", "ttsVoices") { [self] _ in speech.voicesJSON() }
        b.on("B", "ttsSetVoice") { [self] a in speech.setVoice(a.s(0)); return nil }
        b.on("B", "micStart") { [self] _ in ears.start() }
        b.on("B", "micStop") { [self] _ in ears.stop(); return nil }
        b.on("B", "setListening") { [self] a in ears.setListening(a.b(0), preroll: false); return nil }
        b.on("B", "listen") { [self] a in ears.setListening(a.b(0), preroll: a.b(1)); return nil }
        b.on("B", "setSpeaking") { [self] a in ears.setSpeaking(a.b(0)); return nil }
        b.on("B", "setMuted") { [self] a in ears.setMuted(a.b(0)); return nil }
        b.on("B", "setWakeThreshold") { [self] a in ears.setThreshold(Float(a.d(0))); return nil }
        b.on("B", "micStatus") { [self] _ in
            JSBridge.json(["running": ears.running, "wake": ears.hasWake, "vad": ears.hasVad, "wakeError": ears.wakeError, "permission": Ears.permission == .granted])
        }
        b.on("B", "tone") { [self] a in tone.play(freq: a.d(0), ms: a.n(1), volume: a.d(2)); return nil }
        b.on("B", "keepAwake") { a in UIApplication.shared.isIdleTimerDisabled = a.b(0); return nil }
        b.on("B", "httpRequest") { [self] a in http.request(id: a.n(0), method: a.s(1), url: a.s(2), headers: a.s(3), body: a.s(4), timeoutMs: a.n(5)); return nil }
        b.on("B", "httpStream") { [self] a in http.stream(id: a.n(0), method: a.s(1), url: a.s(2), headers: a.s(3), bodyB64: a.s(4), timeoutMs: a.n(5)); return nil }
        b.on("B", "httpAbort") { [self] a in http.abort(id: a.n(0)); return nil }
        b.on("B", "unmetered") { [self] _ in !(net?.isExpensive ?? true) }
        b.on("B", "battery") { [self] _ in battery() }
        b.onAsync("B", "openUrl") { [self] a, done in openUrl(a.s(0), done: done) }
        b.onAsync("B", "openApp") { [self] a, done in openApp(a.s(0), done: done) }
        b.on("B", "media") { [self] a in media(a.s(0), query: a.s(1)) }

        // ---- AndroidPhone: permissions, reminders, device, people, calendar, documents, places, faces
        b.on("P", "status") { [self] _ in status() }
        b.onAsync("P", "request") { [self] a, done in request(a.s(0), done: done) }
        b.on("P", "reminderAdd") { [self] a in reminders.add(a.s(0)) }
        b.on("P", "reminderCancel") { [self] a in reminders.cancel(a.s(0)) }
        b.on("P", "reminderList") { [self] _ in reminders.list() }
        b.on("P", "clockAlarm") { [self] a in reminders.alarm(hour: a.n(0), minute: a.n(1), label: a.s(2), days: a.s(3)) }
        b.on("P", "flashlight") { [self] a in flashlight(a.s(0)) }
        b.on("P", "brightness") { a in
            let l = a.n(0)
            if l < 0 { return "Automatic brightness is a switch in Settings, under Accessibility, Display and Text Size. I can set a level for you instead." }
            UIScreen.main.brightness = CGFloat(min(100, max(1, l))) / 100
            return "Brightness \(min(100, max(0, l))) percent."
        }
        b.onAsync("P", "openSettings") { [self] a, done in
            let p = a.s(0).lowercased()
            openSettingsApp { _ in
                if p.contains("wifi") || p.contains("wi-fi") || p.contains("bluetooth") || p.contains("airplane") || p.contains("hotspot") || p.contains("data") {
                    done("I've opened Settings. Apple doesn't let apps switch Wi-Fi, Bluetooth or airplane mode, but they're one swipe away in Control Center: swipe down from the top-right corner.")
                } else { done("I've opened Settings at my page. Apple doesn't let apps jump to other settings pages.") }
            }
        }
        b.on("P", "bringToFront") { [self] _ in visible ? "ok" : "failed" }
        b.on("P", "isVisible") { [self] _ in visible }
        b.onAsync("P", "findContact") { [self] a, done in findContact(a.s(0), done: done) }
        b.onAsync("P", "call") { [self] a, done in
            let n = a.s(0).filter { "0123456789+*#".contains($0) }
            if n.isEmpty { done("no-number"); return }
            openURL(URL(string: "tel:\(n)")) { ok in done(ok ? "dialer" : "failed") }
        }
        b.onAsync("P", "sms") { [self] a, done in compose([a.s(0)], a.s(1), done: done) }
        b.onAsync("P", "whatsapp") { [self] a, done in
            let n = a.s(0).filter { $0.isNumber }, t = a.s(1)
            let q = t.isEmpty ? "" : "?text=" + (t.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")
            openURL(URL(string: "https://wa.me/\(n)\(q)")) { ok in done(ok ? "ok" : "failed") }
        }
        b.onAsync("P", "birthdays") { [self] _, done in birthdays(done: done) }
        b.onAsync("P", "calendarEvents") { [self] a, done in calendarEvents(a.d(0), a.d(1), done: done) }
        b.onAsync("P", "calendarAdd") { [self] a, done in calendarAdd(a.s(0), a.d(1), a.d(2), a.s(3), a.b(4), done: done) }
        b.on("P", "clipboardGet") { _ in UIPasteboard.general.string ?? "" }
        b.on("P", "clipboardSet") { a in UIPasteboard.general.string = a.s(0); return "ok" }
        b.on("P", "docSave") { [self] a in docs.save(kind: a.s(0), title: a.s(1), content: a.s(2)) }
        b.on("P", "docList") { [self] _ in docs.list() }
        b.on("P", "docOpen") { [self] a in docs.open(a.s(0), share: a.b(2)) }
        b.on("P", "docDelete") { [self] a in docs.delete(a.s(0)) }
        b.onAsync("P", "photoSave") { [self] a, done in docs.savePhoto(a.s(0)) { done($0) } }
        b.on("P", "shiftStart") { [self] _ in location.shiftStart() }
        b.on("P", "shiftEnd") { [self] _ in location.shiftEnd() }
        b.on("P", "shiftStatus") { [self] _ in location.shiftStatus() }
        b.on("P", "trips") { [self] _ in location.trips() }
        b.on("P", "lastLocation") { [self] _ in location.lastJSON() }
        b.onAsync("P", "freshLocation") { [self] a, done in location.freshJSON(timeoutMs: a.n(0)) { done($0) } }
        b.on("P", "geoStart") { [self] a in location.geoStart(a.n(0), once: a.b(1)); return nil }
        b.on("P", "geoStop") { [self] a in location.geoStop(a.n(0)); return nil }
        // iPhone apps can't send texts by themselves: SOS opens the message ready to send (the page does that on "sms")
        b.on("P", "sosStart") { _ in "{\"error\":\"sms\"}" }
        b.on("P", "sosStop") { _ in "{\"error\":\"none\"}" }
        b.on("P", "sosActive") { _ in false }
        b.on("P", "shareLocation") { _ in -1 }
        b.onAsync("P", "placeText") { [self] _, done in location.placeText { done($0) } }
        b.onAsync("P", "dialEmergency") { [self] a, done in
            let n = a.s(0).filter { $0.isNumber }
            openURL(URL(string: "tel:\(n.isEmpty ? "911" : n)")) { ok in done(ok ? "ok" : "failed") }
        }
        b.onAsync("P", "faceRemember") { [self] a, done in faces.remember(a.s(0), name: a.s(1), title: a.s(2)) { done($0) } }
        b.onAsync("P", "faceIdentify") { [self] a, done in faces.identify(a.s(0)) { done($0) } }
        b.on("P", "faceList") { [self] _ in faces.list() }
        b.on("P", "faceForget") { [self] a in faces.forget(a.s(0)) }
    }

    // ================================================================== permissions
    private var contactsOK: Bool {
        let s = CNContactStore.authorizationStatus(for: .contacts)
        if #available(iOS 18.0, *) { if s == .limited { return true } }
        return s == .authorized
    }
    private var calendarOK: Bool {
        let s = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) { return s == .fullAccess }
        return s == .authorized
    }
    private var cameraOK: Bool { AVCaptureDevice.authorizationStatus(for: .video) == .authorized }

    func status() -> String {
        refreshNotif()
        return JSBridge.json([
            "notifications": notifOK, "mic": Ears.permission == .granted, "location": location.allowed, "camera": cameraOK,
            "contacts": contactsOK, "calendar": calendarOK, "calls": true, "sms": true, "brightness": true, "exactAlarms": true,
            "overlay": true, "control": false, "controlRunning": false, "notifAccess": false, "dnd": false, "offer": false,
            "restricted": false, "screenshots": false,
        ])
    }

    /// Asks for one permission (Apple's own question), or for all the ordinary ones in a row ("basics").
    /// Something already refused can only be changed in Settings, so that opens Jarvis's page there.
    func request(_ name: String, done: @escaping (Any?) -> Void) {
        let finish: (String) -> Void = { [weak self] r in
            self?.refreshNotif()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.bridge.js("window.__jvPerm&&window.__jvPerm()") }
            done(r)
        }
        switch name {
        case "basics":                                                  // answered at once; the page hears __jvPerm when all are done
            let steps = ["mic", "location", "notifications", "camera", "contacts", "calendar"]
            func run(_ i: Int) {
                if i >= steps.count { refreshNotif(); bridge.js("window.__jvPerm&&window.__jvPerm()"); return }
                ask(steps[i], openSettingsIfDenied: false) { _ in run(i + 1) }
            }
            done("asked")
            run(0)
        case "appInfo":
            openSettingsApp { _ in finish("opened") }
        default:
            ask(name, openSettingsIfDenied: true) { r in finish(r) }
        }
    }

    private func ask(_ name: String, openSettingsIfDenied: Bool, _ cb: @escaping (String) -> Void) {
        let main: (String) -> Void = { r in DispatchQueue.main.async { cb(r) } }
        let denied: () -> Void = { [weak self] in if openSettingsIfDenied { self?.openSettingsApp { _ in main("opened") } } else { main("denied") } }
        switch name {
        case "mic":
            switch Ears.permission {
            case .granted: main("granted")
            case .denied: denied()
            default:
                AVAudioSession.sharedInstance().requestRecordPermission { [weak self] ok in
                    main(ok ? "granted" : "denied")
                    if ok { self?.bridge.js("window.__jvMic&&window.__jvMic('permission')") }
                }
            }
        case "location":
            if location.allowed { main("granted"); return }
            if location.status != .notDetermined { denied(); return }
            let prev = location.onAuth
            var answered = false
            location.onAuth = { [weak self] in
                prev()
                guard let self = self, !answered, self.location.status != .notDetermined else { return }
                answered = true; self.location.onAuth = prev; main(self.location.allowed ? "granted" : "denied")
            }
            location.ask()
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in if !answered { answered = true; self?.location.onAuth = prev; main("asked") } }
        case "notifications":
            UNUserNotificationCenter.current().getNotificationSettings { [weak self] s in
                if s.authorizationStatus == .notDetermined { self?.reminders.requestPermission { ok in main(ok ? "granted" : "denied") } }
                else if s.authorizationStatus == .denied { DispatchQueue.main.async { denied() } }
                else { main("granted") }
            }
        case "camera":
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: main("granted")
            case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { ok in main(ok ? "granted" : "denied") }
            default: denied()
            }
        case "contacts", "calls", "sms":
            if name != "contacts" { main("granted"); return }        // iPhone: calls and texts open ready for you to tap
            if contactsOK { main("granted"); return }
            if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined { contacts.requestAccess(for: .contacts) { ok, _ in main(ok ? "granted" : "denied") } }
            else { denied() }
        case "calendar":
            if calendarOK { main("granted"); return }
            if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
                if #available(iOS 17.0, *) { events.requestFullAccessToEvents { ok, _ in main(ok ? "granted" : "denied") } }
                else { events.requestAccess(to: .event) { ok, _ in main(ok ? "granted" : "denied") } }
            } else { denied() }
        default:
            main("granted")                                            // nothing to ask on iPhone
        }
    }

    func openSettingsApp(_ done: @escaping (Bool) -> Void) { openURL(URL(string: UIApplication.openSettingsURLString), done) }

    // ================================================================== opening things
    func openURL(_ url: URL?, _ done: @escaping (Bool) -> Void) {
        DispatchQueue.main.async {
            guard let u = url else { done(false); return }
            UIApplication.shared.open(u, options: [:]) { ok in done(ok) }
        }
    }

    private static func coords(_ s: String) -> String? {
        let r = s.range(of: "-?\\d+(\\.\\d+)?,\\s*-?\\d+(\\.\\d+)?", options: .regularExpression)
        return r.map { String(s[$0]).replacingOccurrences(of: " ", with: "") }
    }

    /// Returns "ok" or "failed" (like Android; iPhone opens things only while Jarvis is on screen).
    func openUrl(_ raw: String, done: @escaping (Any?) -> Void) {
        let s = raw.trimmingCharacters(in: .whitespaces)
        let scheme = (s.split(separator: ":").first.map(String.init) ?? "").lowercased()
        let fin: (Bool) -> Void = { done($0 ? "ok" : "failed") }
        switch scheme {
        case "http", "https", "tel", "mailto", "comgooglemaps", "maps", "waze":
            openURL(URL(string: s), fin)
        case "sms", "smsto":
            var rest = String(s.dropFirst(scheme.count + 1)), body = ""
            if let q = rest.firstIndex(of: "?") {
                let query = String(rest[rest.index(after: q)...]); rest = String(rest[..<q])
                for kv in query.split(separator: "&") where kv.hasPrefix("body=") { body = String(kv.dropFirst(5)).removingPercentEncoding ?? "" }
            }
            let numbers = rest.split(whereSeparator: { $0 == ";" || $0 == "," }).map { String($0).removingPercentEncoding ?? String($0) }
            compose(numbers, body) { r in fin((r as? String) == "ok") }
        case "geo":
            let q = s.components(separatedBy: "q=").dropFirst().first.map { $0.removingPercentEncoding ?? $0 } ?? Native.coords(s) ?? ""
            openURL(URL(string: "https://maps.apple.com/?q=" + (q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")), fin)
        case "google.navigation":
            let dest = (s.components(separatedBy: "q=").dropFirst().first ?? "").components(separatedBy: "&").first ?? ""
            let enc = (dest.removingPercentEncoding ?? dest).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            openURL(URL(string: "comgooglemaps://?daddr=\(enc)&directionsmode=driving")) { [weak self] ok in
                if ok { fin(true) } else { self?.openURL(URL(string: "https://maps.apple.com/?daddr=\(enc)&dirflg=d"), fin) }
            }
        case "vnd.youtube":
            let id = String(s.dropFirst("vnd.youtube:".count))
            openURL(URL(string: "youtube://\(id)")) { [weak self] ok in
                if ok { fin(true) } else { self?.openURL(URL(string: "https://www.youtube.com/watch?v=\(id)"), fin) }
            }
        default:
            fin(false)
        }
    }

    static let apps: [String: String] = [
        "whatsapp": "whatsapp://", "spotify": "spotify://", "youtube": "youtube://", "youtubemusic": "youtubemusic://", "instagram": "instagram://",
        "facebook": "fb://", "messenger": "fb-messenger://", "telegram": "tg://", "snapchat": "snapchat://", "tiktok": "snssdk1233://",
        "x": "twitter://", "twitter": "twitter://", "gmail": "googlegmail://", "chrome": "googlechrome://", "googlemaps": "comgooglemaps://",
        "maps": "maps://", "applemaps": "maps://", "waze": "waze://", "uber": "uber://", "ubereats": "ubereats://", "uberdriver": "uberdriver://",
        "doordash": "doordash://", "dasher": "doordashdasher://", "grubhub": "grubhub://", "netflix": "nflx://", "amazon": "com.amazon.mobile.shopping://",
        "linkedin": "linkedin://", "zoom": "zoomus://", "teams": "msteams://", "outlook": "ms-outlook://", "slack": "slack://", "discord": "discord://",
        "paypal": "paypal://", "cashapp": "cashme://", "venmo": "venmo://", "settings": UIApplication.openSettingsURLString, "messages": "sms://",
        "mail": "message://", "safari": "x-web-search://", "photos": "photos-redirect://", "music": "music://", "applemusic": "music://",
        "podcasts": "podcasts://", "calendar": "calshow://", "notes": "mobilenotes://", "reminders": "x-apple-reminderkit://", "clock": "clock-alarm://",
        "weather": "weather://", "appstore": "itms-apps://", "files": "shareddocuments://", "wallet": "shoebox://", "facetime": "facetime://",
        "findmy": "findmy://", "health": "x-apple-health://", "shortcuts": "shortcuts://", "phone": "tel://", "camera": "",
    ]

    func openApp(_ name: String, done: @escaping (Any?) -> Void) {
        var want = name.lowercased().filter { $0.isLetter || $0.isNumber }
        for p in ["the", "my"] where want.hasPrefix(p) && want.count > p.count + 2 { want = String(want.dropFirst(p.count)) }
        if want.hasSuffix("app") && want.count > 5 { want = String(want.dropLast(3)) }
        if want == "camera" { done("Apple doesn't let apps open the Camera app. Swipe left on the lock screen, or I can take a photo myself: say take a picture."); return }
        guard let url = Native.apps[want] ?? Native.apps.first(where: { want.hasPrefix($0.key) || $0.key.hasPrefix(want) })?.value, !url.isEmpty else {
            done("I can't open \(name) on iPhone: Apple only lets me open apps that allow it. Open it from your home screen."); return
        }
        openURL(URL(string: url)) { ok in done(ok ? "ok" : "I couldn't find \(name) on this iPhone.") }
    }

    func media(_ action: String, query: String) -> String {
        let p = MPMusicPlayerController.systemMusicPlayer
        switch action {
        case "play": p.play(); return "ok"
        case "pause": p.pause(); return "ok"
        case "next": p.skipToNextItem(); return "ok"
        case "previous": p.skipToPreviousItem(); return "ok"
        case "play_search":
            let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            openURL(URL(string: "spotify:search:\(q)")) { [weak self] ok in if !ok { self?.openURL(URL(string: "music://music.apple.com/search?term=\(q)")) { _ in } } }
            return "ok"
        default: return "I can't do that with music here."
        }
    }

    func battery() -> String {
        let d = UIDevice.current
        var o: [String: Any] = ["charging": d.batteryState == .charging || d.batteryState == .full]
        if d.batteryLevel >= 0 { o["level"] = Int((d.batteryLevel * 100).rounded()) }
        if let p = net, p.status == .satisfied { o["network"] = p.usesInterfaceType(.wifi) ? "Wi-Fi" : p.usesInterfaceType(.cellular) ? "mobile data" : "a network" }
        else { o["network"] = "" }
        return JSBridge.json(o)
    }

    // ================================================================== device
    func flashlight(_ what: String) -> String {
        guard let dev = AVCaptureDevice.default(for: .video), dev.hasTorch else { return "This phone has no flashlight I can reach." }
        let w = what.lowercased()
        let on = w == "toggle" || w.isEmpty ? dev.torchMode != .on : w != "off"
        do {
            try dev.lockForConfiguration()
            defer { dev.unlockForConfiguration() }
            if on { try dev.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel) } else { dev.torchMode = .off }
            return on ? "Flashlight on." : "Flashlight off."
        } catch {
            return "The camera is in use, so the flashlight can't come on. Close the camera and ask again."
        }
    }

    // ================================================================== messages
    func compose(_ numbers: [String], _ text: String, done: @escaping (Any?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { done("failed"); return }
            let nums = numbers.map { $0.filter { "0123456789+".contains($0) } }.filter { !$0.isEmpty }
            if MFMessageComposeViewController.canSendText(), let top = self.presenter() {
                let vc = MFMessageComposeViewController()
                vc.recipients = nums
                vc.body = text
                vc.messageComposeDelegate = self
                top.present(vc, animated: true)
                done("ok")
            } else {
                let body = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
                let to = nums.count > 1 ? "/open?addresses=\(nums.joined(separator: ","))&body=\(body)" : "\(nums.first ?? "")&body=\(body)"
                self.openURL(URL(string: "sms:\(to)")) { ok in done(ok ? "ok" : "failed") }
            }
        }
    }
    func messageComposeViewController(_ c: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) { c.dismiss(animated: true) }

    // ================================================================== contacts
    private static let nameKeys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactNicknameKey as CNKeyDescriptor]

    func findContact(_ name: String, done: @escaping (Any?) -> Void) {
        guard contactsOK else { done("need-contacts"); return }
        DispatchQueue.global(qos: .userInitiated).async { [contacts] in
            var out: [[String: String]] = [], seen = Set<String>()
            let pred = CNContact.predicateForContacts(matchingName: name.trimmingCharacters(in: .whitespaces))
            let found = (try? contacts.unifiedContacts(matching: pred, keysToFetch: Native.nameKeys)) ?? []
            for c in found {
                let full = CNContactFormatter.string(from: c, style: .fullName) ?? c.nickname
                for pn in c.phoneNumbers where out.count < 8 {
                    let num = pn.value.stringValue.filter { "0123456789+".contains($0) }
                    if num.isEmpty || seen.contains(full + num) { continue }
                    seen.insert(full + num)
                    out.append(["name": full, "number": num, "type": pn.label.map { CNLabeledValue<CNPhoneNumber>.localizedString(forLabel: $0).lowercased() } ?? ""])
                }
            }
            done(JSBridge.json(out))
        }
    }

    func birthdays(done: @escaping (Any?) -> Void) {
        guard contactsOK else { done("need-contacts"); return }
        DispatchQueue.global(qos: .utility).async { [contacts] in
            var out: [[String: Any]] = []
            let req = CNContactFetchRequest(keysToFetch: [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactBirthdayKey as CNKeyDescriptor])
            try? contacts.enumerateContacts(with: req) { c, stop in
                guard let b = c.birthday, let m = b.month, let d = b.day else { return }
                out.append(["name": CNContactFormatter.string(from: c, style: .fullName) ?? "", "md": String(format: "%02ld-%02ld", m, d), "year": b.year ?? 0])
                if out.count >= 2000 { stop.pointee = true }
            }
            done(JSBridge.json(out))
        }
    }

    // ================================================================== calendar
    func calendarEvents(_ from: Double, _ to: Double, done: @escaping (Any?) -> Void) {
        guard calendarOK else { done("need-calendar"); return }
        let pred = events.predicateForEvents(withStart: Date(timeIntervalSince1970: from / 1000), end: Date(timeIntervalSince1970: to / 1000), calendars: nil)
        let list = events.events(matching: pred).sorted { $0.startDate < $1.startDate }.prefix(25).map { e -> [String: Any] in
            ["title": e.title ?? "(no title)", "begin": e.startDate.timeIntervalSince1970 * 1000, "end": e.endDate.timeIntervalSince1970 * 1000,
             "allDay": e.isAllDay, "location": e.location ?? ""]
        }
        done(JSBridge.json(Array(list)))
    }

    func calendarAdd(_ title: String, _ start: Double, _ end: Double, _ place: String, _ allDay: Bool, done: @escaping (Any?) -> Void) {
        guard calendarOK else { done("need-calendar"); return }
        guard let cal = events.defaultCalendarForNewEvents else { done("no-calendar"); return }
        let e = EKEvent(eventStore: events)
        e.calendar = cal
        e.title = title
        e.startDate = Date(timeIntervalSince1970: start / 1000)
        e.endDate = Date(timeIntervalSince1970: max(end, start + 60_000) / 1000)
        e.isAllDay = allDay
        if !place.isEmpty { e.location = place }
        do { try events.save(e, span: .thisEvent); done("ok:" + cal.title) } catch { done("error") }
    }
}
