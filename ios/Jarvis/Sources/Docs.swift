import UIKit
import Photos
import QuickLook
import JarvisCore

/// Documents Jarvis writes (PDF, Word, CSV, text) in Files > On My iPhone > Jarvis, and photos he takes.
final class Docs: NSObject, QLPreviewControllerDataSource {
    private var previewURL: URL?
    var presenter: () -> UIViewController? = { nil }

    static var folder: URL {
        let u = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    private static func safeName(_ s: String) -> String {
        var n = s.replacingOccurrences(of: "[\\\\/:*?\"<>|\\n\\r\\t]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        if n.count > 60 { n = String(n.prefix(60)).trimmingCharacters(in: .whitespaces) }
        return n.isEmpty ? "Jarvis document" : n
    }

    /// A4 PDF with the title in bold, laid out over as many pages as it needs.
    static func pdf(title: String, body: String) -> Data {
        let esc: (String) -> String = { $0.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
        let html = "<html><body style=\"font-family:-apple-system,Helvetica;font-size:11.5pt;color:#222\"><h1 style=\"font-size:20pt;color:#111;margin:0 0 14pt\">\(esc(title))</h1>"
            + body.components(separatedBy: "\n").map { "<p style=\"margin:0 0 4pt\">\($0.isEmpty ? "&nbsp;" : esc($0))</p>" }.joined() + "</body></html>"
        let fmt = UIMarkupTextPrintFormatter(markupText: html)
        let r = UIPrintPageRenderer()
        r.addPrintFormatter(fmt, startingAtPageAt: 0)
        let page = CGRect(x: 0, y: 0, width: 595, height: 842)
        r.setValue(NSValue(cgRect: page), forKey: "paperRect")
        r.setValue(NSValue(cgRect: page.insetBy(dx: 56, dy: 56)), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, page, nil)
        r.prepare(forDrawingPages: NSRange(location: 0, length: r.numberOfPages))
        for i in 0..<max(1, r.numberOfPages) { UIGraphicsBeginPDFPage(); r.drawPage(at: i, in: UIGraphicsGetPDFContextBounds()) }
        UIGraphicsEndPDFContext()
        return data as Data
    }

    /// kind: pdf, docx, csv, txt. -> {"name","uri","mime"} or "error: ...". (Runs on the main thread: UIKit draws the PDF.)
    func save(kind: String, title: String, content: String) -> String {
        let k = kind.lowercased().replacingOccurrences(of: "word", with: "docx").replacingOccurrences(of: ".", with: "")
        let t = title.trimmingCharacters(in: .whitespaces).isEmpty ? "Jarvis document" : title.trimmingCharacters(in: .whitespaces)
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HHmm"; f.locale = Locale(identifier: "en_US_POSIX")
        let stamp = f.string(from: Date())
        let (data, mime, ext): (Data, String, String)
        if k.hasPrefix("pdf") { (data, mime, ext) = (Docs.pdf(title: t, body: content), "application/pdf", ".pdf") }
        else if k.hasPrefix("doc") { (data, mime, ext) = (Docx.make(title: t, body: content), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx") }
        else if k.hasPrefix("csv") { (data, mime, ext) = (Data(content.utf8), "text/csv", ".csv") }
        else { (data, mime, ext) = (Data((t + "\n\n" + content).utf8), "text/plain", ".txt") }
        let url = Docs.folder.appendingPathComponent(Docs.safeName(t) + " " + stamp + ext)
        do { try data.write(to: url) } catch { return "error: \(error.localizedDescription)" }
        return JSBridge.json(["name": url.lastPathComponent, "uri": url.absoluteString, "mime": mime])
    }

    func list() -> String {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: Docs.folder, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey], options: [.skipsHiddenFiles])) ?? []
        let rows: [[String: Any]] = files.compactMap { u in
            guard let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey, .isDirectoryKey]), v.isDirectory != true else { return nil }
            return ["name": u.lastPathComponent, "uri": u.absoluteString, "size": v.fileSize ?? 0, "date": (v.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000]
        }.sorted { (($0["date"] as? Double) ?? 0) > (($1["date"] as? Double) ?? 0) }
        return JSBridge.json(Array(rows.prefix(40)))
    }

    func open(_ uri: String, share: Bool) -> String {
        guard let u = URL(string: uri), FileManager.default.fileExists(atPath: u.path), let top = presenter() else { return "failed" }
        if share {
            let vc = UIActivityViewController(activityItems: [u], applicationActivities: nil)
            vc.popoverPresentationController?.sourceView = top.view
            top.present(vc, animated: true)
        } else {
            previewURL = u
            let ql = QLPreviewController()
            ql.dataSource = self
            top.present(ql, animated: true)
        }
        return "ok"
    }

    func delete(_ uri: String) -> Bool {
        guard let u = URL(string: uri), u.path.hasPrefix(Docs.folder.path) else { return false }
        return (try? FileManager.default.removeItem(at: u)) != nil
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { (previewURL ?? Docs.folder) as NSURL }

    /// Saves a JPEG from Jarvis's camera to Photos. Returns the file name ("" if not allowed).
    func savePhoto(_ b64: String, done: @escaping (String) -> Void) {
        let s = b64.replacingOccurrences(of: "^data:[^,]*,", with: "", options: .regularExpression)
        guard let data = Data(base64Encoded: s, options: .ignoreUnknownCharacters) else { done(""); return }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HHmmss"; f.locale = Locale(identifier: "en_US_POSIX")
        let name = "Jarvis \(f.string(from: Date())).jpg"
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { st in
            guard st == .authorized || st == .limited else { DispatchQueue.main.async { done("") }; return }
            PHPhotoLibrary.shared().performChanges({
                let r = PHAssetCreationRequest.forAsset()
                let o = PHAssetResourceCreationOptions(); o.originalFilename = name
                r.addResource(with: .photo, data: data, options: o)
            }) { ok, _ in DispatchQueue.main.async { done(ok ? name : "") } }
        }
    }
}
