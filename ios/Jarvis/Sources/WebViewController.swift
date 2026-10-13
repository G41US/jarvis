import UIKit
import WebKit

/// Jarvis's screen: the same page as the Android app (the 3D face, the map, settings), served from inside the app,
/// with the phone's abilities plugged in through JSBridge/Native.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let bridge = JSBridge()
    private(set) var native: Native!
    private var server: WebServer!
    private var web: WKWebView!
    private var loaded = false
    private var pendingWake = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        native = Native(bridge: bridge)
        native.presenter = { [weak self] in self?.topController() }

        let root = Bundle.main.resourceURL!.appendingPathComponent("www")
        server = WebServer(root: root)
        let port = server.start()

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        let uc = WKUserContentController()
        uc.addUserScript(WKUserScript(source: bridge.injection(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        uc.add(self, name: "jvlog")
        cfg.userContentController = uc

        web = WKWebView(frame: view.bounds, configuration: cfg)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.uiDelegate = self
        web.navigationDelegate = self
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view.addSubview(web)
        bridge.webView = web

        if port == 0 { showError("Jarvis couldn't start his screen. Close the app and open it again."); return }
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/index.html")!))

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(wake), name: .jarvisWake, object: nil)
    }

    // ---- app lifecycle: the microphone is released in the background (Apple's rule) and comes back with the app
    @objc private func background() { native.ears.pause() }
    @objc private func foreground() { native.ears.resume() }
    @objc private func active() { native.refreshNotif(); bridge.js("window.dispatchEvent(new Event('focus'))") }

    /// "Hey Siri, talk to Jarvis" / the Action Button: open and listen.
    @objc func wake() {
        if !loaded { pendingWake = true; return }
        bridge.js("window.JARVIS&&window.JARVIS.wake()")
    }

    private func topController() -> UIViewController? {
        var top: UIViewController = self
        while let p = top.presentedViewController { top = p }
        return top
    }

    private func showError(_ text: String) {
        let l = UILabel(frame: view.bounds.insetBy(dx: 30, dy: 0))
        l.text = text; l.textColor = .white; l.numberOfLines = 0; l.textAlignment = .center
        l.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(l)
    }

    // ---- first start: the ordinary permissions, asked once, up front (like the Android app)
    private func firstRun() {
        let d = UserDefaults.standard
        guard !d.bool(forKey: "asked_basics_v1") else { _ = native.ears.start(); return }
        d.set(true, forKey: "asked_basics_v1")
        native.request("basics") { _ in }
    }

    // ---- WKNavigationDelegate
    @objc(webView:didFinishNavigation:)
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.firstRun() }
        if pendingWake { pendingWake = false; DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.wake() } }
        if ProcessInfo.processInfo.arguments.contains("-JarvisSmokeTest") { smokeTest() }
    }

    @objc(webView:decidePolicyForNavigationAction:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = action.request.url else { decisionHandler(.cancel); return }
        if u.host == "127.0.0.1" || u.scheme == "about" || u.scheme == "blob" || u.scheme == "data" { decisionHandler(.allow); return }
        if action.targetFrame?.isMainFrame ?? true { UIApplication.shared.open(u) }          // links leave the app (Safari, Maps...)
        decisionHandler(action.targetFrame == nil || action.targetFrame?.isMainFrame == true ? .cancel : .allow)
    }

    @objc(webViewWebContentProcessDidTerminate:)
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }    // iOS freed the page's memory: start it again

    // ---- WKUIDelegate: the bridge, window.open, and the page's camera
    @objc(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if bridge.handle(prompt, done: completionHandler) { return }
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        topController()?.present(a, animated: true)
    }
    @objc(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topController()?.present(a, animated: true)
    }
    @objc(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topController()?.present(a, animated: true)
    }
    @objc(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { UIApplication.shared.open(u) }
        return nil
    }
    @available(iOS 15.0, *)
    @objc(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)     // only Jarvis's own page; iOS still asks you the first time
    }

    // ---- the page's console
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if let s = message.body as? String { NSLog("[PAGE] %@", s) }
    }

    // ---- the build's check in the simulator (launched with -JarvisSmokeTest): the page starts, commands work
    private func smokeTest() {
        let steps: [(Double, String)] = [
            (6, "(()=>{ try { JARVIS.config.set('setup_v1', true); document.querySelectorAll('#jv-setup.on,#jv-ov.on').forEach(e=>e.classList.remove('on')); document.body.classList.remove('jv-settings'); window.__jvPaused=false; } catch(e){} return 'ready ' + JSON.stringify({ ios: !!window.JARVIS_IOS, tools: JARVIS.reg.schemas.length, mic: JARVIS.stats.mic, api: JARVIS.api.mode(), voices: JARVIS.voices().length, screen: !!JARVIS.reg.has('read_screen') }); })()"),
            (9, "JARVIS.reg.exec('get_time','{}')"),
            (10, "JARVIS.reg.exec('flashlight', JSON.stringify({state:'on'}))"),
            (11, "JARVIS.reg.exec('list_reminders','{}')"),
            (12, "JARVIS.reg.exec('create_document', JSON.stringify({title:'Smoke test', content:'Hello from the simulator', format:'pdf'}))"),
            (14, "(async()=>{ JARVIS.wake(); await new Promise(r=>setTimeout(r,400)); JARVIS.say('what time is it'); return 'asked'; })()"),
            (20, "JSON.stringify({ log: document.getElementById('log') ? document.getElementById('log').textContent.slice(-400) : '', stats: { mic: JARVIS.stats.mic, wake: JARVIS.stats.wake, vad: JARVIS.stats.vad } })"),
        ]
        for (t, code) in steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                self?.web.callAsyncJavaScript("return await (" + code + ")", arguments: [:], in: nil, in: .page) { r in
                    switch r {
                    case .success(let v): NSLog("[SMOKE] %@", String(describing: v))
                    case .failure(let e): NSLog("[SMOKE] failed: %@", e.localizedDescription)
                    }
                }
            }
        }
    }
}

extension Notification.Name { static let jarvisWake = Notification.Name("jarvisWake") }
