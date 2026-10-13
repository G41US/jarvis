import Foundation

/// Web requests for the page, made by the app (no browser cross-origin rules, a real User-Agent which Nominatim needs,
/// and streaming for the AI's answers). Same calls and results as the Android app's Bridge.httpRequest/httpStream.
final class Http: NSObject, URLSessionDataDelegate {
    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) Jarvis/1.3"
    private let bridge: JSBridge
    private lazy var plain = URLSession(configuration: .default)
    private lazy var streaming = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private var streams: [Int: Int] = [:]          // task id -> page id
    private var live: [Int: URLSessionDataTask] = [:]
    private let lock = NSLock()

    init(bridge: JSBridge) { self.bridge = bridge }

    /// https anywhere; plain http only to devices on your own network (Home Assistant, a Hue bridge).
    static func allowed(_ s: String) -> Bool {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased() else { return false }
        if scheme == "https" { return true }
        guard scheme == "http", let h = u.host?.lowercased() else { return false }
        return privateHost(h)
    }
    static func privateHost(_ h: String) -> Bool {
        if h.hasSuffix(".local") || h == "homeassistant" || h.hasSuffix(".lan") || h.hasSuffix(".home.arpa") { return true }
        return h.range(of: "^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|169\\.254\\.)[0-9.]+$", options: .regularExpression) != nil
    }

    private func request(_ method: String, _ url: String, _ headersJSON: String, _ body: Data?, _ timeoutMs: Int, defaultTimeout: Int, cap: Int) -> URLRequest? {
        guard let u = URL(string: url) else { return nil }
        var r = URLRequest(url: u)
        r.httpMethod = method.isEmpty ? "GET" : method.uppercased()
        r.timeoutInterval = Double(max(3000, min(timeoutMs > 0 ? timeoutMs : defaultTimeout, cap))) / 1000
        r.setValue(Http.ua, forHTTPHeaderField: "User-Agent")
        if let h = JSBridge.parse(headersJSON.isEmpty ? "{}" : headersJSON) as? [String: Any] {
            for (k, v) in h { r.setValue("\(v)", forHTTPHeaderField: k) }
        }
        if let b = body, !b.isEmpty, r.httpMethod != "GET" { r.httpBody = b }
        return r
    }

    /// One request; the answer goes to window.__httpResult(id, status, text).
    func request(id: Int, method: String, url: String, headers: String, body: String, timeoutMs: Int) {
        guard Http.allowed(url), let r = request(method, url, headers, Data(body.utf8), timeoutMs, defaultTimeout: 12000, cap: 60000) else {
            bridge.js("window.__httpResult&&window.__httpResult(\(id),0,'')"); return
        }
        plain.dataTask(with: r) { [bridge] data, resp, err in
            let status = err == nil ? ((resp as? HTTPURLResponse)?.statusCode ?? 0) : 0
            let text = data.map { String(decoding: $0.prefix(6 * 1024 * 1024), as: UTF8.self) } ?? ""
            bridge.js("window.__httpResult&&window.__httpResult(\(id),\(status),\(JSBridge.q(text)))")
        }.resume()
    }

    /// A streamed request (the AI's answers arrive word by word): __httpHead, __httpChunk (base64), __httpEnd.
    func stream(id: Int, method: String, url: String, headers: String, bodyB64: String, timeoutMs: Int) {
        guard url.hasPrefix("https://"), let r = request(method, url, headers, Data(base64Encoded: bodyB64), timeoutMs, defaultTimeout: 60000, cap: 120000) else {
            bridge.js("window.__httpEnd&&window.__httpEnd(\(id),'https only')"); return
        }
        let t = streaming.dataTask(with: r)
        lock.lock(); streams[t.taskIdentifier] = id; live[id] = t; lock.unlock()
        t.resume()
    }

    func abort(id: Int) {
        lock.lock(); let t = live.removeValue(forKey: id); lock.unlock()
        t?.cancel()
    }

    private func pageId(_ task: URLSessionTask) -> Int? { lock.lock(); defer { lock.unlock() }; return streams[task.taskIdentifier] }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let id = pageId(dataTask) { bridge.js("window.__httpHead&&window.__httpHead(\(id),\((response as? HTTPURLResponse)?.statusCode ?? 0))") }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let id = pageId(dataTask) { bridge.js("window.__httpChunk&&window.__httpChunk(\(id),'\(data.base64EncodedString())')") }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = pageId(task) else { return }
        lock.lock(); streams.removeValue(forKey: task.taskIdentifier); live.removeValue(forKey: id); lock.unlock()
        let e = error.map { ($0 as NSError).code == NSURLErrorCancelled ? "aborted" : $0.localizedDescription }
        bridge.js("window.__httpEnd&&window.__httpEnd(\(id),\(e.map { JSBridge.q($0) } ?? "''"))")
    }
}
