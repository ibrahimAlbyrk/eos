import Cocoa
import WebKit

private let DAEMON = "http://127.0.0.1:7400"

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    private var adjustingButtons = false
    private var defaultContainerOrigin: NSPoint?

    func applicationDidFinishLaunching(_: Notification) {
        setupWindow()
        ensureDaemon()
    }

    private func setupWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        cfg.userContentController.addUserScript(
            WKUserScript(source: "document.documentElement.classList.add('native');",
                         injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let dblClickJS = """
        document.addEventListener('dblclick', (e) => {
            let el = e.target;
            while (el) {
                const region = getComputedStyle(el).webkitAppRegion;
                if (region === 'no-drag') return;
                if (region === 'drag') {
                    window.webkit.messageHandlers.titlebarDblClick.postMessage(null);
                    return;
                }
                el = el.parentElement;
            }
        });
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: dblClickJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        cfg.userContentController.add(self, name: "titlebarDblClick")

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.wantsLayer = true
        webView.layer?.backgroundColor = NSColor(white: 0.102, alpha: 1).cgColor

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Eos"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 800, height: 500)
        window.backgroundColor = NSColor(white: 0.102, alpha: 1)
        window.contentView = webView
        window.center()
        window.delegate = self
        window.setFrameAutosaveName("Eos")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        positionTrafficLights()
    }

    private func positionTrafficLights() {
        guard !adjustingButtons else { return }
        adjustingButtons = true
        defer { adjustingButtons = false }
        guard let close = window.standardWindowButton(.closeButton),
              let container = close.superview else { return }
        if defaultContainerOrigin == nil { defaultContainerOrigin = container.frame.origin }
        let base = defaultContainerOrigin ?? container.frame.origin
        container.setFrameOrigin(NSPoint(x: base.x + 16, y: base.y - 14))
    }

    func windowDidResize(_: Notification) { positionTrafficLights() }

    @objc func handleTitlebarDoubleClick(_: Any?) {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }
    func windowDidBecomeKey(_: Notification) { positionTrafficLights() }

    func windowWillEnterFullScreen(_: Notification) {
        webView.evaluateJavaScript("document.documentElement.classList.add('fullscreen');")
    }

    func windowDidExitFullScreen(_: Notification) {
        webView.evaluateJavaScript("document.documentElement.classList.remove('fullscreen');")
        defaultContainerOrigin = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.positionTrafficLights()
        }
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
        WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast) { [weak self] in
            guard let url = URL(string: "\(DAEMON)/web/") else { return }
            self?.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    private func repoRoot() -> String {
        if let e = ProcessInfo.processInfo.environment["CLAUDE_MGR_REPO_ROOT"] { return e }
        // <repoRoot>/app/build/Eos.app/Contents/MacOS/Eos
        var d = Bundle.main.executablePath ?? ""
        for _ in 0..<5 { d = (d as NSString).deletingLastPathComponent }
        if FileManager.default.fileExists(atPath: "\(d)/manager/daemon.ts") { return d }
        return "/Users/ibrahimalbyrk/Projects/CC/claude-manager"
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

    @objc func reloadPage(_: Any?) { webView.reload() }

    func userContentController(_: WKUserContentController, didReceive _: WKScriptMessage) {
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
