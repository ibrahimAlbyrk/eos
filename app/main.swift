import Cocoa
import WebKit
import UserNotifications

private let DAEMON = "http://127.0.0.1:7400"

// Nudges the traffic lights from AppKit's unified-toolbar spot (x 19, center-y 26)
// to the design spot (x 27, center-y 31) — aligned with the web breadcrumb row.
// Moves each BUTTON inside its (tall) titlebar container, never the container,
// so hit-testing stays exact. Idempotent: re-applying is a no-op unless AppKit
// re-laid the frames; suspended in fullscreen where the overlay owns layout.
final class TrafficLightPositioner {
    private static let dx: CGFloat = 8
    private static let dy: CGFloat = -5 // bottom-left origin: negative = down
    private static let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
    private weak var window: NSWindow?
    private var applied: [NSWindow.ButtonType: NSRect] = [:]
    private var suspended = false

    init(window: NSWindow) {
        self.window = window
    }

    func apply() {
        guard !suspended, let window else { return }
        for type in Self.buttons {
            guard let button = window.standardWindowButton(type) else { continue }
            if button.frame == applied[type] { continue }
            let target = button.frame.offsetBy(dx: Self.dx, dy: Self.dy)
            button.setFrameOrigin(target.origin)
            applied[type] = target
        }
    }

    func suspend() {
        guard let window, !suspended else { return }
        suspended = true
        for type in Self.buttons {
            guard let button = window.standardWindowButton(type) else { continue }
            if button.frame == applied[type] {
                button.setFrameOrigin(NSPoint(x: button.frame.origin.x - Self.dx,
                                              y: button.frame.origin.y - Self.dy))
            }
            applied[type] = nil
        }
    }

    func resume() {
        suspended = false
        apply()
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate, URLSessionDataDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    // Empty toolbar + .unified style = tall titlebar; AppKit centers and insets
    // the traffic lights natively (resize/fullscreen/hit-testing all correct).
    // Detached during fullscreen so the reveal strip shows only the buttons.
    private let titlebarToolbar = NSToolbar()
    private var trafficLights: TrafficLightPositioner!
    private var sseSession: URLSession?
    private var sseTask: URLSessionDataTask?
    private var sseBuffer = Data()

    func applicationDidFinishLaunching(_: Notification) {
        setupNotifications()
        setupWindow()
        ensureDaemon()
    }

    private func setupWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        cfg.userContentController.addUserScript(
            WKUserScript(source: """
                document.documentElement.classList.add('native');
                document.addEventListener('contextmenu', e => {
                    if (!e.defaultPrevented) e.preventDefault();
                });
                """,
                         injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        // WKWebView ignores `-webkit-app-region`, so the titlebar drag/zoom is driven
        // from JS: on mousedown over an `--app-region: drag` element we ask native to
        // move the window (performWindowDragWithEvent). Double-click (detail>=2) zooms
        // instead — handled in the same mousedown so the native drag loop can't eat it.
        let titlebarJS = """
        (function () {
            function appRegion(el) {
                return el ? getComputedStyle(el).getPropertyValue('--app-region').trim() : '';
            }
            document.addEventListener('mousedown', function (e) {
                if (e.button !== 0 || appRegion(e.target) !== 'drag') return;
                const handler = e.detail >= 2 ? 'titlebarDblClick' : 'titlebarDrag';
                window.webkit.messageHandlers[handler].postMessage(null);
            }, true);
        })();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: titlebarJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        cfg.userContentController.add(self, name: "titlebarDblClick")
        cfg.userContentController.add(self, name: "titlebarDrag")
        cfg.userContentController.add(self, name: "themeChanged")
        cfg.userContentController.add(self, name: "themeSnapshot")

        // Last resolved theme (posted by theme.js) so the window/webview bg
        // matches before the page paints — no dark flash in light mode.
        let theme = initialTheme()

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.wantsLayer = true
        webView.layer?.backgroundColor = themeBackground(theme).cgColor

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Eos"
        // created before `window.delegate = self`: setFrameAutosaveName fires
        // windowDidResize synchronously, which already calls trafficLights.apply()
        trafficLights = TrafficLightPositioner(window: window)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.toolbar = titlebarToolbar
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width: 800, height: 500)
        window.backgroundColor = themeBackground(theme)
        window.contentView = webView
        window.center()
        window.delegate = self
        window.setFrameAutosaveName("Eos")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        trafficLights.apply()
    }

    func windowDidResize(_: Notification) { trafficLights.apply() }
    func windowDidBecomeKey(_: Notification) { trafficLights.apply() }

    // theme.js posts the resolved theme ("dark"/"light"); never set
    // window.appearance — it would freeze prefers-color-scheme inside the
    // webview and break the System theme mode.
    private func themeBackground(_ theme: String) -> NSColor {
        theme == "light"
            ? NSColor(red: 246 / 255.0, green: 241 / 255.0, blue: 230 / 255.0, alpha: 1) // --bg #f6f1e6
            : NSColor(white: 0.102, alpha: 1) // --bg #1a1a1a
    }

    private func initialTheme() -> String {
        if let saved = UserDefaults.standard.string(forKey: "EosTheme") { return saved }
        return NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua ? "light" : "dark"
    }

    @objc func handleTitlebarDoubleClick(_: Any?) {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }
    func windowWillEnterFullScreen(_: Notification) {
        trafficLights.suspend()
        window.toolbar = nil
        webView.evaluateJavaScript("document.documentElement.classList.add('fullscreen');")
    }

    func windowDidExitFullScreen(_: Notification) {
        window.toolbar = titlebarToolbar
        trafficLights.resume()
        webView.evaluateJavaScript("document.documentElement.classList.remove('fullscreen');")
    }

    // MARK: - Daemon lifecycle

    private func ensureDaemon() {
        checkHealth { [weak self] ok in
            ok ? self?.loadWeb() : self?.spawnDaemon()
        }
    }

    private func checkHealth(_ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "\(DAEMON)/health") else { done(false); return }
        URLSession.shared.dataTask(with: url) { _, r, _ in
            DispatchQueue.main.async { done((r as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    private func spawnDaemon() {
        let root = repoRoot()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", "--no-warnings", "--experimental-strip-types",
                        "\(root)/manager/daemon.ts"]
        p.standardInput  = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError  = FileHandle.nullDevice
        do { try p.run() } catch {
            showAlert("Daemon could not start:\n\(error.localizedDescription)")
            return
        }
        poll(40)
    }

    private func poll(_ n: Int) {
        guard n > 0 else {
            showAlert("Daemon failed to start.\nRun `eos start -f` manually.")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.checkHealth { ok in
                ok ? self?.loadWeb() : self?.poll(n - 1)
            }
        }
    }

    private func loadWeb() {
        // Per-boot UI token handshake: the daemon writes ~/.claude-mgr/ui-token
        // at startup; injecting it here (post-health, so a freshly spawned
        // daemon has written it) lets the web layer call checkout-mutating
        // endpoints. Agents only hold the daemon URL — not this token.
        let tokenPath = ("~/.claude-mgr/ui-token" as NSString).expandingTildeInPath
        if let token = try? String(contentsOfFile: tokenPath, encoding: .utf8) {
            let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty, t.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil {
                webView.configuration.userContentController.addUserScript(
                    WKUserScript(source: "window.__EOS_UI_TOKEN = '\(t)';",
                                 injectionTime: .atDocumentStart, forMainFrameOnly: true)
                )
            }
        }
        // Clear only HTTP caches so a rebuilt dist/ loads fresh — wiping
        // allWebsiteDataTypes() would also delete localStorage (input history,
        // active view, scroll positions) on every launch.
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
            modifiedSince: .distantPast) { [weak self] in
            guard let url = URL(string: "\(DAEMON)/web/") else { return }
            self?.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            self?.connectSSE()
        }
    }

    private func repoRoot() -> String {
        if let e = ProcessInfo.processInfo.environment["CLAUDE_MGR_REPO_ROOT"] { return e }
        // <repoRoot>/app/build/Eos.app/Contents/MacOS/Eos — 6 components up to <repoRoot>
        var d = Bundle.main.executablePath ?? ""
        for _ in 0..<6 { d = (d as NSString).deletingLastPathComponent }
        if FileManager.default.fileExists(atPath: "\(d)/manager/daemon.ts") { return d }
        if let baked = Bundle.main.object(forInfoDictionaryKey: "CLAUDEMgrRepoRoot") as? String,
           FileManager.default.fileExists(atPath: "\(baked)/manager/daemon.ts") { return baked }
        return d
    }

    // MARK: - Notifications

    private func setupNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if !granted {
                NSLog("[Eos] notification permission denied: \(error?.localizedDescription ?? "unknown")")
            }
        }
    }

    func userNotificationCenter(_: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let wid = response.notification.request.content.userInfo["workerId"] as? String {
            webView.evaluateJavaScript("window.__nativeNavigate?.('\(wid)')")
        }
        done()
    }

    func userNotificationCenter(_: UNUserNotificationCenter,
                                willPresent _: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    private func showNotification(title: String, body: String, workerId: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["workerId": workerId]
        let req = UNNotificationRequest(identifier: "worker-\(workerId)",
                                        content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // MARK: - SSE

    private func connectSSE() {
        sseTask?.cancel()
        sseBuffer = Data()
        guard let url = URL(string: "\(DAEMON)/stream") else { return }
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = TimeInterval(INT_MAX)
        cfg.timeoutIntervalForResource = TimeInterval(INT_MAX)
        sseSession = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        sseTask = sseSession?.dataTask(with: req)
        sseTask?.resume()
    }

    private func handleSSELine(_ line: String) {
        guard line.hasPrefix("data: ") else { return }
        let json = String(line.dropFirst(6))
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let reason = obj["reason"] as? String,
              reason == "notification:fire" else { return }

        guard !NSApp.isActive else { return }

        guard let payload = obj["payload"] as? [String: Any],
              let title = payload["title"] as? String,
              let body = payload["body"] as? String else { return }

        let workerId = payload["workerId"] as? String ?? ""
        showNotification(title: title, body: body, workerId: workerId)
    }

    // MARK: - Navigation

    func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated,
           url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation: WKNavigation!, withError: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.loadWeb()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }

    // MARK: - URLSessionDataDelegate (SSE streaming)

    func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive data: Data) {
        sseBuffer.append(data)
        while let range = sseBuffer.range(of: Data("\n".utf8)) {
            let lineData = sseBuffer.subdata(in: sseBuffer.startIndex..<range.lowerBound)
            sseBuffer.removeSubrange(sseBuffer.startIndex...range.lowerBound)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                handleSSELine(line)
            }
        }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError _: Error?) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.connectSSE()
        }
    }

    @objc func reloadPage(_: Any?) { webView.reload() }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "themeSnapshot" {
            // Freeze the current frame for the JS circular theme reveal — the
            // page flips theme under this image so backdrop-filter stays live.
            webView.takeSnapshot(with: nil) { [weak self] image, _ in
                guard let self else { return }
                guard let image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
                else {
                    self.webView.evaluateJavaScript("window.__eosThemeSnapshot && window.__eosThemeSnapshot(null)")
                    return
                }
                let b64 = jpeg.base64EncodedString()
                self.webView.evaluateJavaScript(
                    "window.__eosThemeSnapshot && window.__eosThemeSnapshot('data:image/jpeg;base64,\(b64)')")
            }
            return
        }
        if message.name == "themeChanged" {
            if let theme = message.body as? String {
                UserDefaults.standard.set(theme, forKey: "EosTheme")
                let bg = themeBackground(theme)
                webView.layer?.backgroundColor = bg.cgColor
                window.backgroundColor = bg
            }
            return
        }
        if message.name == "titlebarDrag" {
            if let event = NSApp.currentEvent {
                window.performDrag(with: event)
            }
            return
        }
        handleTitlebarDoubleClick(nil)
    }

    private func showAlert(_ msg: String) {
        let a = NSAlert()
        a.messageText = "Eos"
        a.informativeText = msg
        a.alertStyle = .critical
        a.runModal()
    }
}

// MARK: - Bootstrap

let app = NSApplication.shared
let del = AppDelegate()
app.delegate = del

let menu = NSMenu()

let ai = NSMenuItem(); menu.addItem(ai)
let am = NSMenu()
am.addItem(NSMenuItem(title: "About Eos",
                       action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
am.addItem(.separator())
am.addItem(NSMenuItem(title: "Quit Eos",
                       action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
ai.submenu = am

let ei = NSMenuItem(); menu.addItem(ei)
let em = NSMenu(title: "Edit")
em.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
em.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
em.addItem(.separator())
em.addItem(NSMenuItem(title: "Cut",        action: #selector(NSText.cut(_:)),       keyEquivalent: "x"))
em.addItem(NSMenuItem(title: "Copy",       action: #selector(NSText.copy(_:)),      keyEquivalent: "c"))
em.addItem(NSMenuItem(title: "Paste",      action: #selector(NSText.paste(_:)),     keyEquivalent: "v"))
em.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
ei.submenu = em

let vi = NSMenuItem(); menu.addItem(vi)
let vm = NSMenu(title: "View")
let ri = NSMenuItem(title: "Reload", action: #selector(AppDelegate.reloadPage(_:)), keyEquivalent: "r")
ri.target = del
vm.addItem(ri)
vi.submenu = vm

let wi = NSMenuItem(); menu.addItem(wi)
let wm = NSMenu(title: "Window")
wm.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
wm.addItem(NSMenuItem(title: "Zoom",     action: #selector(NSWindow.performZoom(_:)),        keyEquivalent: ""))
wi.submenu = wm
app.windowsMenu = wm

app.mainMenu = menu
app.run()
