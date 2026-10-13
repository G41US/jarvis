import Foundation
import WebKit

typealias Args = [Any]

/// The page was written for Android, where it calls `window.AndroidBridge.x(...)` and `window.AndroidPhone.y(...)` and
/// gets an answer straight back. This gives the page the same two objects on iPhone. Each call goes through the web
/// view's prompt() panel, which WebKit lets the app answer later while the page waits, so the page's code runs as is.
/// Only the methods an iPhone can do are listed; the page checks for a method before it uses it.
final class JSBridge {
    typealias Sync = (Args) -> Any?
    typealias Async = (Args, @escaping (Any?) -> Void) -> Void
    weak var webView: WKWebView?
    private var sync: [String: [String: Sync]] = ["B": [:], "P": [:]]
    private var async: [String: [String: Async]] = ["B": [:], "P": [:]]
    static let marker = "__jvb__"

    func on(_ obj: String, _ name: String, _ f: @escaping Sync) { sync[obj, default: [:]][name] = f }
    func onAsync(_ obj: String, _ name: String, _ f: @escaping Async) { async[obj, default: [:]][name] = f }

    func methods(_ obj: String) -> [String] { Array(Set((sync[obj] ?? [:]).keys).union((async[obj] ?? [:]).keys)).sorted() }

    /// True when the prompt was one of ours (it is then answered through `done`).
    func handle(_ prompt: String, done: @escaping (String?) -> Void) -> Bool {
        guard prompt.hasPrefix(JSBridge.marker) else { return false }
        let json = String(prompt.dropFirst(JSBridge.marker.count))
        guard let arr = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [Any], arr.count >= 2,
              let obj = arr[0] as? String, let name = arr[1] as? String else { done(nil); return true }
        let args = (arr.count > 2 ? arr[2] as? [Any] : nil) ?? []
        let reply: (Any?) -> Void = { v in
            var val: Any = v ?? NSNull()
            if let d = val as? Double, !d.isFinite { val = NSNull() }
            let box: [String: Any] = ["r": val]
            guard JSONSerialization.isValidJSONObject(box), let data = try? JSONSerialization.data(withJSONObject: box) else { done("{\"r\":null}"); return }
            done(String(decoding: data, as: UTF8.self))
        }
        if let f = sync[obj]?[name] {
            reply(f(args))
        } else if let f = async[obj]?[name] {
            f(args) { v in DispatchQueue.main.async { reply(v) } }
        } else {
            NSLog("[JARVIS] no native method %@.%@", obj, name)
            reply(nil)
        }
        return true
    }

    /// Runs page code (from any thread).
    func js(_ code: String) {
        DispatchQueue.main.async { [weak self] in self?.webView?.evaluateJavaScript(code, completionHandler: nil) }
    }

    /// A JavaScript string literal.
    static func q(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let t = String(decoding: d, as: UTF8.self)
        return String(t.dropFirst().dropLast())
    }
    /// JSON text of any JSON-able value.
    static func json(_ v: Any) -> String {
        guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v) else { return v is [Any] ? "[]" : "{}" }
        return String(decoding: d, as: UTF8.self)
    }
    static func parse(_ s: String) -> Any? { try? JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed]) }

    /// The script placed into the page before anything else runs.
    func injection() -> String {
        let b = JSBridge.json(methods("B")), p = JSBridge.json(methods("P"))
        return """
        (() => {
          const call = (o, m, a) => {
            const r = prompt('\(JSBridge.marker)' + JSON.stringify([o, m, a]));
            if (r === null || r === undefined) return undefined;
            try { return JSON.parse(r).r; } catch (e) { return undefined; }
          };
          const make = (o, list) => { const x = {}; for (const m of list) x[m] = (...a) => call(o, m, a); return x; };
          window.JARVIS_IOS = true;
          window.AndroidBridge = make('B', \(b));
          window.AndroidPhone = make('P', \(p));
          // the page's console reaches Xcode / the build log
          const log = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.jvlog;
          if (log) for (const k of ['log', 'warn', 'error']) {
            const orig = console[k].bind(console);
            console[k] = (...a) => { try { log.postMessage(k + ' ' + a.map(x => { try { return typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x); } catch (e) { return String(x); } }).join(' ').slice(0, 2000)); } catch (e) {} orig(...a); };
          }
          window.addEventListener('error', e => { try { log && log.postMessage('error ' + e.message + ' @' + e.filename + ':' + e.lineno); } catch (x) {} });
          // location from the phone itself (no extra "allow location for 127.0.0.1" question, works while driving)
          const watches = new Map(); let gid = 1;
          const pos = p => ({ coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc, altitude: null, altitudeAccuracy: null,
            heading: p.heading >= 0 ? p.heading : null, speed: p.speed >= 0 ? p.speed : null }, timestamp: p.ts });
          window.__jvGeo = (id, p, err) => {
            const w = watches.get(id); if (!w) return;
            if (err) { if (w.e) try { w.e({ code: err, message: 'location unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); } catch (e) {} if (w.once) watches.delete(id); return; }
            if (w.once) watches.delete(id);
            try { w.s && w.s(pos(p)); } catch (e) { console.error(e); }
          };
          const geo = {
            getCurrentPosition(s, e) { const id = gid++; watches.set(id, { s, e, once: true }); call('P', 'geoStart', [id, true]); },
            watchPosition(s, e) { const id = gid++; watches.set(id, { s, e }); call('P', 'geoStart', [id, false]); return id; },
            clearWatch(id) { watches.delete(id); call('P', 'geoStop', [id]); },
          };
          try { Object.defineProperty(Navigator.prototype, 'geolocation', { get: () => geo, configurable: true }); } catch (e) {}
          try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch (e) {}
        })();
        """
    }
}

// ---------------------------------------------------------------------- argument helpers
extension Array where Element == Any {
    func s(_ i: Int) -> String { i < count ? ((self[i] as? String) ?? (self[i] as? NSNumber)?.stringValue ?? "") : "" }
    func d(_ i: Int) -> Double { i < count ? ((self[i] as? NSNumber)?.doubleValue ?? Double(s(i)) ?? 0) : 0 }
    func n(_ i: Int) -> Int { Int(d(i)) }
    func b(_ i: Int) -> Bool { i < count ? ((self[i] as? NSNumber)?.boolValue ?? (s(i) == "true")) : false }
}
