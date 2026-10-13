import Foundation
import Network

/// Serves Jarvis's page (the same one the Android app uses) from inside the app at http://127.0.0.1:<port>.
/// A loopback address counts as a secure origin, so the page gets the camera, WebGL and ES modules exactly as on
/// Android; nothing is reachable from outside the phone. The port is fixed so the page's saved settings stay put.
final class WebServer {
    private let root: URL
    private let queue = DispatchQueue(label: "jarvis.web", qos: .userInitiated)
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    init(root: URL) { self.root = root.standardizedFileURL }

    /// Starts on the first free port from `preferred`; returns it (0 if nothing could start).
    @discardableResult
    func start(preferred: UInt16 = 47321) -> UInt16 {
        for p in preferred..<(preferred + 8) {
            if let l = try? listen(on: p) { listener = l; port = p; return p }
        }
        return 0
    }

    private func listen(on p: UInt16) throws -> NWListener {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: NWEndpoint.Port(rawValue: p)!)
        let l = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        var ok = false
        l.stateUpdateHandler = { st in
            switch st {
            case .ready: ok = true; ready.signal()
            case .failed, .cancelled: ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.serve(c) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        if !ok { l.cancel(); throw NSError(domain: "WebServer", code: Int(p)) }
        l.stateUpdateHandler = nil
        return l
    }

    private func serve(_ c: NWConnection) {
        c.start(queue: queue)
        read(c, Data())
    }

    private func read(_ c: NWConnection, _ have: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self = self else { c.cancel(); return }
            var buf = have
            if let d = data { buf.append(d) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(c, head: String(decoding: buf[..<end.lowerBound], as: UTF8.self))
            } else if done || err != nil || buf.count > 1 << 20 {
                c.cancel()
            } else {
                self.read(c, buf)
            }
        }
    }

    static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
        "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2", "wasm": "application/wasm", "txt": "text/plain; charset=utf-8",
        "mp3": "audio/mpeg", "wav": "audio/wav", "onnx": "application/octet-stream", "bin": "application/octet-stream",
    ]

    private func respond(_ c: NWConnection, head: String) {
        let first = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let parts = first.split(separator: " ")
        let method = parts.first.map(String.init) ?? "GET"
        var path = parts.count > 1 ? String(parts[1]) : "/"
        if let q = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path
        if path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).standardizedFileURL
        var status = "200 OK", type = "text/plain", body = Data()
        if !file.path.hasPrefix(root.path) || path.contains("..") {
            status = "403 Forbidden"
        } else if let d = try? Data(contentsOf: file, options: .mappedIfSafe) {
            body = d
            type = WebServer.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        } else {
            status = "404 Not Found"; body = Data("not found".utf8)
        }
        if method == "OPTIONS" { status = "204 No Content"; body = Data() }
        var h = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-cache\r\n"
        h += "Access-Control-Allow-Origin: *\r\nCross-Origin-Resource-Policy: cross-origin\r\nConnection: close\r\n\r\n"
        var out = Data(h.utf8)
        if method != "HEAD" { out.append(body) }
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }
}
