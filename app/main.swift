import Cocoa
import ObjectiveC
import WebKit
import UserNotifications
import QuartzCore
import CoreImage

private let DAEMON = "http://127.0.0.1:7400"
private let WINDOW_CORNER_RADIUS: CGFloat = 10

// macOS Tahoe (26) draws large window corners — larger still for toolbar windows
// (Eos uses a unified NSToolbar), which is why ours look softer than other apps.
// No public API reduces it, but NSThemeFrame reads the radius from these private
// methods; overriding them at launch (before any window exists) makes AppKit draw
// the tighter radius itself — no layer masking, so no clipping/flicker artifacts.
// Local self-signed app, so calling private API directly (no dylib injection) is
// fine; a missing selector on another OS version is a harmless no-op.
private func installWindowCornerRadius(_ radius: CGFloat) {
    guard let cls = NSClassFromString("NSThemeFrame") else { return }

    let radiusBlock: @convention(block) (AnyObject) -> CGFloat = { _ in radius }
    let radiusIMP = imp_implementationWithBlock(radiusBlock)
    for name in ["_cornerRadius", "_getCachedWindowCornerRadius"] {
        if let m = class_getInstanceMethod(cls, NSSelectorFromString(name)) {
            method_setImplementation(m, radiusIMP)
        }
    }

    let sizeBlock: @convention(block) (AnyObject) -> CGSize = { _ in CGSize(width: radius, height: radius) }
    let sizeIMP = imp_implementationWithBlock(sizeBlock)
    for name in ["_topCornerSize", "_bottomCornerSize"] {
        if let m = class_getInstanceMethod(cls, NSSelectorFromString(name)) {
            method_setImplementation(m, sizeIMP)
        }
    }
}

// Nudges the traffic lights from AppKit's unified-toolbar spot (x 19, center-y 26)
// to the design spot (x 19, center-y 23) — 13px from the sidebar island's corner,
// which sits at the 6px --shell-gap inset (collapsed breadcrumb row matches).
// Moves each BUTTON inside its (tall) titlebar container, never the container,
// so hit-testing stays exact. Idempotent: re-applying is a no-op unless AppKit
// re-laid the frames; suspended in fullscreen where the overlay owns layout.
final class TrafficLightPositioner {
    private static let dx: CGFloat = 0
    private static let dy: CGFloat = 3 // bottom-left origin: positive = up
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

// WKWebView never exposes absolute file paths to JS (clipboardData/dataTransfer
// carry blob copies; a folder surfaces as an unreadable typeless File), so the
// composer's Finder paste/drop support is fed from here.
private func pasteboardFileEntries(_ pb: NSPasteboard) -> [[String: Any]] {
    let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
    guard let urls = pb.readObjects(forClasses: [NSURL.self], options: opts) as? [URL] else { return [] }
    return urls.map { url in
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
        return ["path": url.path, "isDir": isDir.boolValue]
    }
}

// Intercepts Finder drags at the AppKit layer (the DOM never sees the paths)
// and hands them to the web composer via the nativeBridge.js window globals.
// Non-file drags fall through to WKWebView's own handling untouched.
final class EosWebView: WKWebView {
    private var fileDrag = false

    private func isFileDrag(_ info: NSDraggingInfo) -> Bool {
        info.draggingPasteboard.canReadObject(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
    }

    override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
        fileDrag = isFileDrag(info)
        guard fileDrag else { return super.draggingEntered(info) }
        evaluateJavaScript("window.__eosDragState?.(true)")
        return .copy
    }

    override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
        fileDrag ? .copy : super.draggingUpdated(info)
    }

    override func draggingExited(_ info: NSDraggingInfo?) {
        guard fileDrag else { return super.draggingExited(info) }
        fileDrag = false
        evaluateJavaScript("window.__eosDragState?.(false)")
    }

    override func prepareForDragOperation(_ info: NSDraggingInfo) -> Bool {
        fileDrag ? true : super.prepareForDragOperation(info)
    }

    override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
        guard fileDrag else { return super.performDragOperation(info) }
        fileDrag = false
        evaluateJavaScript("window.__eosDragState?.(false)")
        let entries = pasteboardFileEntries(info.draggingPasteboard)
        guard !entries.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: entries),
              let json = String(data: data, encoding: .utf8) else { return false }
        evaluateJavaScript("window.__eosNativeDrop?.(\(json))")
        return true
    }
}

// Key events the page doesn't preventDefault (WASD in a game iframe, keys
// with nothing focused) travel back up the responder chain and hit NSWindow's
// default noResponder(for:), which calls NSBeep — swallow keyDown there.
final class QuietWindow: NSWindow {
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)) { return }
        super.noResponder(for: eventSelector)
    }
}

// Serves the bundled web UI (Contents/Resources/ui) under the eos://app/
// origin. A custom scheme — not file:// — because WKWebView gives file://
// pages an opaque origin with unreliable localStorage, and the UI persists
// input history / active view / scroll positions there.
final class BundledUISchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
        super.init()
    }

    func webView(_: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL)); return
        }
        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        let fileURL = root.appendingPathComponent(rel).standardizedFileURL

        guard fileURL.path == root.path || fileURL.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: fileURL) else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/plain; charset=utf-8"])!
            task.didReceive(resp)
            task.didReceive(Data("not found".utf8))
            task.didFinish()
            return
        }
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: [
                                       "Content-Type": Self.mime(fileURL.pathExtension),
                                       "Content-Length": String(data.count),
                                   ])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_: WKWebView, stop _: WKURLSchemeTask) {}

    private static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate, URLSessionDataDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    // Empty toolbar + .unified style = tall titlebar; AppKit centers and insets
    // the traffic lights natively (resize/fullscreen/hit-testing all correct).
    // Detached during fullscreen so the reveal strip shows only the buttons.
    private let titlebarToolbar = NSToolbar()
    private var trafficLights: TrafficLightPositioner!
    private var splashWindow: NSWindow?
    private var sseSession: URLSession?
    private var sseTask: URLSessionDataTask?
    private var sseBuffer = Data()
    // loadWeb() runs on every (re)load — retry, relaunch, update. The token
    // user-script must be added only once; re-adding accumulates duplicate
    // WKUserScripts. (removeAllUserScripts is NOT an option — it would also drop
    // the setup-time context-menu and titlebar-drag scripts.)
    private var tokenScriptInjected = false
    // Menu-bar status indicator — owned for the process lifetime so the retained
    // NSStatusItem is never dropped (a dropped owner removes it from the bar).
    private var statusBar: StatusBarCoordinator?
    // The real mouse-down NSEvent behind a titlebar drag. performDrag needs the
    // originating mouse-down, but the titlebarDrag message arrives async from the
    // web content process — by then NSApp.currentEvent may be a later mousemove,
    // which performDrag ignores. A local monitor caches every leftMouseDown as it
    // is pulled from the queue, so the handler always has the right one.
    private var lastMouseDown: NSEvent?

    func applicationDidFinishLaunching(_: Notification) {
        setupNotifications()
        setupWindow()
        ensureDaemon()
        setupStatusBar()
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            self?.lastMouseDown = event
            return event
        }
    }

    private func setupWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // The web UI ships inside the app bundle (Contents/Resources/ui) and is
        // served from the eos://app/ origin by BundledUISchemeHandler — the
        // daemon no longer serves it over HTTP.
        if let uiRoot = Bundle.main.resourceURL?.appendingPathComponent("ui") {
            cfg.setURLSchemeHandler(BundledUISchemeHandler(root: uiRoot), forURLScheme: "eos")
        }

        // The UI loads from eos://app/, so its API/SSE calls to the loopback
        // daemon are cross-origin; tell the web layer where the daemon lives
        // (it can no longer derive it from location.origin).
        cfg.userContentController.addUserScript(
            WKUserScript(source: "window.__EOS_DAEMON_URL = '\(DAEMON)';",
                         injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        cfg.userContentController.addUserScript(
            WKUserScript(source: """
                document.documentElement.classList.add('native');
                document.addEventListener('contextmenu', e => {
                    if (!e.defaultPrevented) e.preventDefault();
                });
                """,
                         injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        // The main-frame script above doesn't reach cross-origin subframes; raw
        // content (HTML games, pdf.js) lives on the 7401 origin and must not
        // pop the native context menu either.
        cfg.userContentController.addUserScript(
            WKUserScript(source: """
                if (location.port === '7401') {
                    document.addEventListener('contextmenu', e => {
                        if (!e.defaultPrevented) e.preventDefault();
                    });
                }
                """,
                         injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        // WKWebView ignores `-webkit-app-region`, so the titlebar drag/zoom is driven
        // from JS: on mousedown over an `--app-region: drag` element we ask native to
        // move the window (performWindowDrag). We track double-click via timestamps
        // because performWindowDrag runs a modal loop that resets WebKit's click-count,
        // making e.detail unreliable for the second click.
        let titlebarJS = """
        (function () {
            function appRegion(el) {
                return el ? getComputedStyle(el).getPropertyValue('--app-region').trim() : '';
            }
            var lastDragClick = 0;
            document.addEventListener('mousedown', function (e) {
                if (e.button !== 0 || appRegion(e.target) !== 'drag') return;
                var now = Date.now();
                var isDbl = (now - lastDragClick) < 400;
                lastDragClick = isDbl ? 0 : now;
                window.webkit.messageHandlers[isDbl ? 'titlebarDblClick' : 'titlebarDrag'].postMessage(null);
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
        cfg.userContentController.add(self, name: "saveFile")
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "pasteboardPaths")

        // Last resolved theme (posted by theme.js) so the window/webview bg
        // matches before the page paints — no dark flash in light mode.
        let theme = initialTheme()

        webView = EosWebView(frame: .zero, configuration: cfg)
        // macOS 13.3+ gates Safari Web Inspector attach behind isInspectable
        // (developerExtrasEnabled alone no longer opens it). Local self-signed
        // dev app, so keeping it always-on is fine.
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.navigationDelegate = self
        webView.wantsLayer = true
        webView.layer?.backgroundColor = themeBackground(theme).cgColor

        window = QuietWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Eos"
        // Background-app behaviour (product decision #1): closing the window must
        // NOT quit the app, and the window must stay reusable so the menu-bar item
        // and AgentNavigator can re-show it. Default isReleasedWhenClosed would
        // free it on close, leaving a dangling reference.
        window.isReleasedWhenClosed = false
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
        // NSThemeFrame only registers once a window's frame view exists (just
        // above, via contentView), so swizzle here — before first paint, so the
        // window never flashes the default 26pt radius.
        installWindowCornerRadius(WINDOW_CORNER_RADIUS)
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
            ok ? self?.launchAfterHealthy() : self?.spawnDaemon()
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
        // Run under bash to lift the daemon's fd soft limit to the hard ceiling
        // before exec: the GUI launch default soft limit is 256, too low for a
        // process supervising many PTYs + git/file watches — exhausting it breaks
        // every child_process spawn with EBADF/EMFILE. Raise soft to hard (the real
        // cap is kern.maxfilesperproc) rather than a fixed number so large
        // checkouts don't hit a low ceiling. Output goes to ~/.eos/logs/daemon.log
        // (the StructLogger writes to stdout/stderr; nullDevice would discard every
        // line, including any spawn/EMFILE storm).
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        let entry = "\(root)/manager/daemon.ts"
        p.arguments = ["-c", "ulimit -Sn \"$(ulimit -Hn)\" 2>/dev/null; exec /usr/bin/env node --no-warnings --experimental-strip-types '\(entry)'"]
        p.standardInput  = FileHandle.nullDevice
        let logOut = daemonLogHandle()
        p.standardOutput = logOut ?? FileHandle.nullDevice
        p.standardError  = logOut ?? FileHandle.nullDevice
        do { try p.run() } catch {
            showAlert("Daemon could not start:\n\(error.localizedDescription)")
            return
        }
        poll(40)
    }

    private func daemonLogHandle() -> FileHandle? {
        let dir = ("~/.eos/logs" as NSString).expandingTildeInPath
        let path = dir + "/daemon.log"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let h = FileHandle(forWritingAtPath: path) else { return nil }
        h.seekToEndOfFile()
        return h
    }

    private func poll(_ n: Int) {
        guard n > 0 else {
            showAlert("Daemon failed to start.\nRun `eos start -f` manually.")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.checkHealth { ok in
                ok ? self?.launchAfterHealthy() : self?.poll(n - 1)
            }
        }
    }

    private func loadWeb() {
        // Per-boot UI token handshake: the daemon writes ~/.eos/ui-token
        // at startup; injecting it here (post-health, so a freshly spawned
        // daemon has written it) lets the web layer call checkout-mutating
        // endpoints. Agents only hold the daemon URL — not this token.
        if !tokenScriptInjected {
            let tokenPath = ("~/.eos/ui-token" as NSString).expandingTildeInPath
            if let token = try? String(contentsOfFile: tokenPath, encoding: .utf8) {
                let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty, t.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil {
                    webView.configuration.userContentController.addUserScript(
                        WKUserScript(source: "window.__EOS_UI_TOKEN = '\(t)';",
                                     injectionTime: .atDocumentStart, forMainFrameOnly: true)
                    )
                    tokenScriptInjected = true
                }
            }
        }
        // Clear only HTTP caches so a rebuilt dist/ loads fresh — wiping
        // allWebsiteDataTypes() would also delete localStorage (input history,
        // active view, scroll positions) on every launch.
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
            modifiedSince: .distantPast) { [weak self] in
            guard let url = URL(string: "eos://app/index.html") else { return }
            self?.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            self?.connectSSE()
        }
    }

    // MARK: - Auto-update (launch splash)

    // Called once the daemon is confirmed healthy, before the web UI loads. If
    // the daemon already knows a newer build is available (from its periodic
    // check), apply it now and show a splash so the app opens already-updated —
    // the "reopen ⇒ update" path. No update ⇒ load the web UI as before with no
    // delay (this reads the cached status, never a blocking git fetch).
    private func launchAfterHealthy() {
        updateAvailable { [weak self] available in
            guard let self = self else { return }
            if available { self.runLaunchUpdate() } else { self.loadWeb() }
        }
    }

    private func updateAvailable(_ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "\(DAEMON)/api/updates/status") else { done(false); return }
        var req = URLRequest(url: url); req.timeoutInterval = 4
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var available = false
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                available = (obj["available"] as? Bool) ?? false
            }
            DispatchQueue.main.async { done(available) }
        }.resume()
    }

    private func runLaunchUpdate() {
        showSplashWindow()
        let preBundle = bundleStamp()
        healthStamp { [weak self] preDaemon in
            guard let self = self else { return }
            self.applyUpdate { started in
                guard started else { self.finishSplashThenLoadWeb(); return }   // refused → open old
                // The build SIGTERMs + respawns the daemon with a new source
                // stamp; wait for that, then reload — or relaunch if the app
                // binary itself changed (web/daemon-only updates reload in place).
                self.waitForNewDaemon(preDaemon: preDaemon, attempts: 240) { ok in
                    if ok && self.bundleStamp() != preBundle { self.relaunchSelf() }
                    else { self.finishSplashThenLoadWeb() }
                }
            }
        }
    }

    private func applyUpdate(_ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "\(DAEMON)/api/updates/apply") else { done(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 12
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        if let token = uiToken() { req.setValue(token, forHTTPHeaderField: "x-eos-ui-token") }
        req.httpBody = "{\"relaunchApp\":false}".data(using: .utf8)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var started = false
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                started = (obj["started"] as? Bool) ?? false
            }
            DispatchQueue.main.async { done(started) }
        }.resume()
    }

    // Poll /health every second until it reports a DIFFERENT source stamp than
    // before the apply (= the rebuilt daemon is up). The daemon is briefly down
    // mid-restart; those failed polls just retry until the attempt budget runs
    // out (~4 min, enough for a full deps+web+app+daemon build).
    private func waitForNewDaemon(preDaemon: String?, attempts: Int, _ done: @escaping (Bool) -> Void) {
        guard attempts > 0 else { done(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self else { return }
            self.healthStamp { stamp in
                if let stamp = stamp, !stamp.isEmpty, stamp != (preDaemon ?? "") { done(true) }
                else { self.waitForNewDaemon(preDaemon: preDaemon, attempts: attempts - 1, done) }
            }
        }
    }

    private func healthStamp(_ done: @escaping (String?) -> Void) {
        guard let url = URL(string: "\(DAEMON)/health") else { done(nil); return }
        var req = URLRequest(url: url); req.timeoutInterval = 4
        URLSession.shared.dataTask(with: req) { data, r, _ in
            var stamp: String? = nil
            if (r as? HTTPURLResponse)?.statusCode == 200, let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                stamp = obj["sourceStamp"] as? String
            }
            DispatchQueue.main.async { done(stamp) }
        }.resume()
    }

    private func bundleStamp() -> String {
        let p = Bundle.main.bundlePath + "/Contents/Resources/.eos-stamp"
        return (try? String(contentsOfFile: p, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func uiToken() -> String? {
        let p = ("~/.eos/ui-token" as NSString).expandingTildeInPath
        guard let raw = try? String(contentsOfFile: p, encoding: .utf8) else { return nil }
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return (!t.isEmpty && t.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil) ? t : nil
    }

    private func relaunchSelf() {
        // Detach a tiny shell that waits for this process to quit, then reopens
        // the (now rebuilt) bundle so the new native binary is the one running.
        let path = Bundle.main.bundlePath
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 0.6; open \"\(path)\""]
        try? p.run()
        NSApp.terminate(nil)
    }

    // Minimal launch splash as a SEPARATE borderless window — a small floating
    // glass panel (logo, "Eos", an indeterminate bar). On macOS 26 it uses the
    // real Liquid Glass (NSGlassEffectView: transparent, refractive, correct
    // rounded corners + shadow); older systems fall back to a vibrancy view
    // rounded with a mask image. The main window stays hidden until
    // finishSplashThenLoadWeb() dismisses the panel.
    private func showSplashWindow() {
        if splashWindow != nil { return }
        window.orderOut(nil)   // separate panel only — hide the main window

        let size = NSSize(width: 280, height: 200)
        let radius: CGFloat = 30

        // Content: logo (gently floating), "Eos", a thin indeterminate bar.
        let content = NSView(frame: NSRect(origin: .zero, size: size))
        content.autoresizingMask = [.width, .height]

        let img = NSImageView()
        img.image = NSImage(contentsOfFile: repoRoot() + "/app/ui/public/logo.png")
        img.imageScaling = .scaleProportionallyUpOrDown
        img.wantsLayer = true
        img.layer?.cornerRadius = 16
        img.layer?.masksToBounds = true
        img.translatesAutoresizingMaskIntoConstraints = false
        img.widthAnchor.constraint(equalToConstant: 64).isActive = true
        img.heightAnchor.constraint(equalToConstant: 64).isActive = true
        let floaty = CABasicAnimation(keyPath: "transform.translation.y")
        floaty.fromValue = 0
        floaty.toValue = -5
        floaty.duration = 1.6
        floaty.autoreverses = true
        floaty.repeatCount = .infinity
        floaty.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        img.layer?.add(floaty, forKey: "floaty")

        let name = NSTextField(labelWithAttributedString: NSAttributedString(
            string: "Eos",
            attributes: [
                .font: NSFont.systemFont(ofSize: 16, weight: .semibold),
                .foregroundColor: NSColor.white,
                .kern: 2.5,
            ]))

        let bar = NSView()
        bar.wantsLayer = true
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.widthAnchor.constraint(equalToConstant: 168).isActive = true
        bar.heightAnchor.constraint(equalToConstant: 3).isActive = true
        bar.layer?.backgroundColor = NSColor(calibratedWhite: 1, alpha: 0.18).cgColor
        bar.layer?.cornerRadius = 1.5
        bar.layer?.masksToBounds = true
        let hl = CAGradientLayer()
        hl.colors = [NSColor.clear.cgColor,
                     NSColor(srgbRed: 0.42, green: 0.62, blue: 1, alpha: 1).cgColor,
                     NSColor.clear.cgColor]
        hl.startPoint = NSPoint(x: 0, y: 0.5)
        hl.endPoint = NSPoint(x: 1, y: 0.5)
        hl.frame = CGRect(x: 0, y: 0, width: 84, height: 3)
        bar.layer?.addSublayer(hl)
        let sweep = CABasicAnimation(keyPath: "transform.translation.x")
        sweep.fromValue = -90
        sweep.toValue = 174
        sweep.duration = 1.25
        sweep.repeatCount = .infinity
        sweep.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        hl.add(sweep, forKey: "sweep")

        let stack = NSStackView(views: [img, name, bar])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        let panel = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                             styleMask: [.borderless], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        if #available(macOS 26.0, *) {
            // Real Liquid Glass — transparent + refractive, correct rounded corners
            // and shadow. A faint dark tint keeps the white text legible.
            let glass = NSGlassEffectView(frame: NSRect(origin: .zero, size: size))
            glass.cornerRadius = radius
            glass.tintColor = NSColor(calibratedWhite: 0, alpha: 0.10)
            glass.contentView = content
            panel.contentView = glass
        } else {
            // < macOS 26: vibrancy rounded with a mask IMAGE — layer.cornerRadius
            // alone leaves the window shadow square. Dark appearance for glass.
            panel.appearance = NSAppearance(named: .darkAqua)
            let glass = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
            glass.material = .popover
            glass.blendingMode = .behindWindow
            glass.state = .active
            glass.maskImage = roundedMaskImage(radius: radius)
            glass.addSubview(content)
            panel.contentView = glass
        }

        panel.center()
        panel.makeKeyAndOrderFront(nil)
        panel.invalidateShadow()
        NSApp.activate(ignoringOtherApps: true)
        splashWindow = panel
    }

    private func roundedMaskImage(radius: CGFloat) -> NSImage {
        let d = radius * 2 + 2
        let image = NSImage(size: NSSize(width: d, height: d), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius + 1, left: radius + 1, bottom: radius + 1, right: radius + 1)
        image.resizingMode = .stretch
        return image
    }

    // Grow + fade the panel out (it "expands" away), then reveal the main window
    // with the freshly loaded UI — the minimal panel hands off to the real app.
    private func finishSplashThenLoadWeb() {
        guard let panel = splashWindow else {
            window.makeKeyAndOrderFront(nil); loadWeb(); return
        }
        splashWindow = nil
        let start = panel.frame
        let grown = NSRect(x: start.midX - start.width * 0.66,
                           y: start.midY - start.height * 0.66,
                           width: start.width * 1.32, height: start.height * 1.32)
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.5
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrame(grown, display: true)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            panel.orderOut(nil)
            self?.window.makeKeyAndOrderFront(nil)
            self?.loadWeb()
        })
    }

    private func repoRoot() -> String {
        if let e = ProcessInfo.processInfo.environment["EOS_REPO_ROOT"] { return e }
        // <repoRoot>/app/build/Eos.app/Contents/MacOS/Eos — 6 components up to <repoRoot>
        var d = Bundle.main.executablePath ?? ""
        for _ in 0..<6 { d = (d as NSString).deletingLastPathComponent }
        if FileManager.default.fileExists(atPath: "\(d)/manager/daemon.ts") { return d }
        if let baked = Bundle.main.object(forInfoDictionaryKey: "EosRepoRoot") as? String,
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
        // A user-clicked link must NEVER navigate the SPA's own frame: a full-frame
        // load of the app's own eos:// scheme would replace the running UI with a
        // dead scheme-handler page recoverable only by relaunch. External links
        // (http/https/mailto) open in the OS browser; the app's own eos:// links are
        // handled in-app (the markdown preview intercepts them in JS) so any that
        // reach here are simply cancelled. Non-link navigations — the initial SPA
        // load and any programmatic/JS navigation — are still allowed.
        if action.navigationType == .linkActivated {
            if let url = action.request.url, url.scheme != "eos", url.host != "127.0.0.1" {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation: WKNavigation!, withError: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.loadWeb()
        }
    }

    // Product decision #1: Eos is a background app. Closing the window leaves the
    // process (and the menu-bar status item) running; Quit is offered from the
    // status item. Reopening (Dock click / status-item "Open Eos") re-shows the
    // window via applicationShouldHandleReopen + ensureMainWindowVisible.
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }

    // Fired on every quit; the daemon purges all archived agents only when
    // config archive.purgeOnAppClose is set, else no-ops (idempotent). The
    // response is ignored, but a brief bounded wait keeps the process alive
    // long enough for the request to actually reach the daemon — a plain
    // fire-and-forget dies with the process before hitting the wire.
    func applicationWillTerminate(_: Notification) {
        guard let url = URL(string: "\(DAEMON)/workers/archived/app-closed") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 2
        if let token = uiToken() { req.setValue(token, forHTTPHeaderField: "x-eos-ui-token") }
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 2)
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { ensureMainWindowVisible() }
        return true
    }

    // MARK: - Menu-bar status indicator

    private func setupStatusBar() {
        let navigator = WebViewAgentNavigator(
            window: { [weak self] in self?.window },
            webView: { [weak self] in self?.webView },
            ensureWindow: { [weak self] in self?.ensureMainWindowVisible() }
        )
        statusBar = StatusBarCoordinator(
            navigator: navigator,
            brandImage: brandMarkImage(),
            onQuit: { NSApp.terminate(nil) },
            onOpenWindow: { [weak self] in self?.ensureMainWindowVisible() }
        )
        statusBar?.start()
    }

    func ensureMainWindowVisible() {
        if window == nil { setupWindow(); loadWeb() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // Full-colour Eos dawn-star for the popover header: the bundled web asset
    // (Contents/Resources/ui/logo.png) in a built app, the source PNG in dev.
    private func brandMarkImage() -> NSImage? {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("ui/logo.png"),
           let img = NSImage(contentsOf: url) { return img }
        return NSImage(contentsOfFile: repoRoot() + "/app/ui/public/logo.png")
    }

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

    // The Edit menu's ⌘Z/⌘⇧Z are consumed before the WebView's keydown, so they
    // forward to the composer's own debounced undo stack (window.__eosUndo).
    @objc func eosUndo(_: Any?) { webView.evaluateJavaScript("window.__eosUndo?.()", completionHandler: nil) }
    @objc func eosRedo(_: Any?) { webView.evaluateJavaScript("window.__eosRedo?.()", completionHandler: nil) }

    // Cmd+V path lookup: the web paste handler awaits this when the clipboard
    // carries files, so Finder copies paste as path references (folders too).
    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "pasteboardPaths" else { replyHandler(nil, nil); return }
        replyHandler(pasteboardFileEntries(NSPasteboard.general), nil)
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "saveFile" {
            guard let dict = message.body as? [String: String],
                  let filename = dict["filename"],
                  let base64 = dict["base64"],
                  let data = Data(base64Encoded: base64) else { return }
            DispatchQueue.main.async {
                let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
                let dest = downloads.appendingPathComponent(filename)
                do {
                    try data.write(to: dest)
                    NSWorkspace.shared.open(dest)
                } catch {
                    NSLog("saveFile: write failed: %@", error.localizedDescription)
                }
            }
            return
        }
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
            if let event = lastMouseDown ?? NSApp.currentEvent {
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

// MARK: - Remote Access preferences
//
// Configures the daemon's REMOTE exposure (config.remote in ~/.eos/config.json)
// — the iOS remote-control edge. This NEVER touches the WebView, which stays on
// loopback (DAEMON above): the LAN-IP field sets the daemon's bind for the /ws
// gateway, not the app's webview. Changes apply on the next daemon restart.

final class RemotePrefsWindowController: NSObject {
    private var window: NSWindow?
    private let modePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let relayURL = NSTextField()
    private let relayRoom = NSTextField()
    private let lanHost = NSTextField()
    private let qrView = NSImageView()
    private let pairStatus = NSTextField(labelWithString: "")

    private var configPath: String { ("~/.eos/config.json" as NSString).expandingTildeInPath }
    private var uiTokenPath: String { ("~/.eos/ui-token" as NSString).expandingTildeInPath }

    func show() {
        if window == nil { build() }
        loadFromConfig()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func build() {
        let contentSize = NSSize(width: 460, height: 560)
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: contentSize),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Remote Access"
        // NSWindow defaults to isReleasedWhenClosed = true: closing it (the red
        // button or Save) would release the window while this controller still
        // holds a strong `window` ref — a dangling pointer that crashes (EXC_BAD_
        // ACCESS) the NEXT time "Remote Access…" reopens it. We reuse the window,
        // so own its lifetime via ARC instead.
        w.isReleasedWhenClosed = false
        let v = NSView(frame: NSRect(origin: .zero, size: contentSize))

        modePopup.addItems(withTitles: ["off", "lan", "relay"])
        relayURL.placeholderString = "wss://your-relay.example/"
        relayRoom.placeholderString = "room id (b64u)"
        lanHost.placeholderString = "0.0.0.0 (LAN bind for /ws)"

        let rows: [(String, NSView)] = [
            ("Mode", modePopup), ("Relay URL", relayURL),
            ("Relay Room", relayRoom), ("LAN bind IP", lanHost),
        ]
        var y: CGFloat = 510
        for (label, field) in rows {
            let l = NSTextField(labelWithString: label)
            l.frame = NSRect(x: 20, y: y, width: 100, height: 22)
            l.alignment = .right
            field.frame = NSRect(x: 130, y: y, width: 300, height: 24)
            v.addSubview(l); v.addSubview(field)
            y -= 36
        }
        let note = NSTextField(labelWithString: "Off by default. Save applies immediately — no restart.")
        note.frame = NSRect(x: 20, y: 360, width: 410, height: 20)
        note.textColor = .secondaryLabelColor
        note.font = .systemFont(ofSize: 11)
        v.addSubview(note)

        let save = NSButton(title: "Save", target: self, action: #selector(saveTapped))
        save.frame = NSRect(x: 20, y: 320, width: 90, height: 30)
        v.addSubview(save)

        let pair = NSButton(title: "Pair device…", target: self, action: #selector(pairTapped))
        pair.frame = NSRect(x: 120, y: 320, width: 130, height: 30)
        v.addSubview(pair)

        // QR area: arming returns the §6 payload; we render it for the phone to
        // scan. The QR encodes the pairing JSON only — no daemon secret beyond the
        // single-use ots/bearer already meant to be transferred by the scan.
        qrView.frame = NSRect(x: 102, y: 40, width: 256, height: 256)
        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.wantsLayer = true
        v.addSubview(qrView)
        pairStatus.frame = NSRect(x: 20, y: 300, width: 420, height: 18)
        pairStatus.textColor = .secondaryLabelColor
        pairStatus.font = .systemFont(ofSize: 11)
        v.addSubview(pairStatus)

        w.contentView = v
        window = w
    }

    private func uiToken() -> String? {
        guard let t = try? String(contentsOfFile: uiTokenPath, encoding: .utf8) else { return nil }
        let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // POST the loopback pairing-arm route and render the returned QR payload.
    @objc private func pairTapped() {
        guard let token = uiToken() else { pairStatus.stringValue = "No ui-token found (~/.eos/ui-token)."; return }
        guard let url = URL(string: DAEMON + "/api/remote/pair") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "x-eos-ui-token")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{}".utf8)
        pairStatus.stringValue = "Arming pairing…"
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard code == 200, let data = data else {
                    self.pairStatus.stringValue = code == 409 ? "Remote not armed — set Mode + Save first." : "Pair failed (HTTP \(code))."
                    return
                }
                if let img = self.makeQR(from: data) {
                    self.qrView.image = img
                    self.pairStatus.stringValue = "Scan with the Eos iOS app. One-time, expires soon."
                } else {
                    self.pairStatus.stringValue = "Could not render the QR payload."
                }
            }
        }.resume()
    }

    // Render the raw pairing-payload JSON bytes as a QR image.
    private func makeQR(from payload: Data) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(payload, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let ci = filter.outputImage else { return nil }
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let rep = NSCIImageRep(ciImage: scaled)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }

    private func readConfig() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: configPath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    private func loadFromConfig() {
        let cfg = readConfig()
        let remote = cfg["remote"] as? [String: Any] ?? [:]
        modePopup.selectItem(withTitle: (remote["mode"] as? String) ?? "off")
        let relay = remote["relay"] as? [String: Any] ?? [:]
        relayURL.stringValue = (relay["url"] as? String) ?? ""
        relayRoom.stringValue = (relay["room"] as? String) ?? ""
        let lan = remote["lan"] as? [String: Any] ?? [:]
        lanHost.stringValue = (lan["host"] as? String) ?? ""
    }

    @objc private func saveTapped() {
        var cfg = readConfig()
        let mode = modePopup.titleOfSelectedItem ?? "off"
        var remote: [String: Any] = ["mode": mode]
        let url = relayURL.stringValue.trimmingCharacters(in: .whitespaces)
        let room = relayRoom.stringValue.trimmingCharacters(in: .whitespaces)
        if !url.isEmpty || !room.isEmpty { remote["relay"] = ["url": url, "room": room] }
        let host = lanHost.stringValue.trimmingCharacters(in: .whitespaces)
        if !host.isEmpty { remote["lan"] = ["host": host] }
        cfg["remote"] = remote
        // LAN mode needs the daemon to bind a routable interface for /ws; the
        // loopback-lock keeps every other REST surface off-box. The WebView is
        // unaffected (it always talks to 127.0.0.1).
        if mode == "lan", !host.isEmpty {
            var daemon = cfg["daemon"] as? [String: Any] ?? [:]
            daemon["host"] = host
            cfg["daemon"] = daemon
        }
        guard let out = try? JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted, .sortedKeys]) else {
            pairStatus.stringValue = "Could not serialize config."
            return
        }
        do {
            try out.write(to: URL(fileURLWithPath: configPath))
        } catch {
            pairStatus.stringValue = "Could not write config: \(error.localizedDescription)"
            return
        }
        armRemoteLive(mode: mode)
    }

    // Apply the saved config live — no restart. POST the loopback arm route; the
    // daemon reloads config and arms/disarms the remote edge immediately. All
    // response handling hops to the main thread; nil/error/non-200 surface inline
    // (no force-unwraps, no modal that could leave the window in a bad state).
    private func armRemoteLive(mode: String) {
        guard let token = uiToken() else {
            pairStatus.stringValue = "Saved. No ui-token to apply live (~/.eos/ui-token)."
            return
        }
        guard let url = URL(string: DAEMON + "/api/remote/arm") else {
            pairStatus.stringValue = "Saved. Invalid daemon URL."
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "x-eos-ui-token")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{}".utf8)
        pairStatus.stringValue = "Applying…"
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let err = err {
                    self.pairStatus.stringValue = "Saved, but apply failed: \(err.localizedDescription)"
                    return
                }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard code == 200 else {
                    self.pairStatus.stringValue = "Saved, but apply failed (HTTP \(code)). Restart Eos to apply."
                    return
                }
                var armed = false
                if let data = data,
                   let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    armed = (obj["armed"] as? Bool) ?? false
                }
                if mode == "off" {
                    self.pairStatus.stringValue = "Remote disabled — applied live."
                } else if armed {
                    self.pairStatus.stringValue = "Remote \(mode) armed — live, no restart needed."
                } else {
                    self.pairStatus.stringValue = "Saved \(mode), but not armed (check relay URL/room)."
                }
            }
        }.resume()
    }
}

let remotePrefs = RemotePrefsWindowController()

extension AppDelegate {
    @objc func openRemotePreferences(_: Any?) { remotePrefs.show() }
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
let remoteItem = NSMenuItem(title: "Remote Access…", action: #selector(AppDelegate.openRemotePreferences(_:)), keyEquivalent: ",")
remoteItem.target = del
am.addItem(remoteItem)
am.addItem(.separator())
am.addItem(NSMenuItem(title: "Quit Eos",
                       action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
ai.submenu = am

let ei = NSMenuItem(); menu.addItem(ei)
let em = NSMenu(title: "Edit")
let undoItem = NSMenuItem(title: "Undo", action: #selector(AppDelegate.eosUndo(_:)), keyEquivalent: "z")
undoItem.target = del
em.addItem(undoItem)
let redoItem = NSMenuItem(title: "Redo", action: #selector(AppDelegate.eosRedo(_:)), keyEquivalent: "Z")
redoItem.target = del
em.addItem(redoItem)
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
