// Navigation layer — "bring agent X to the foreground." The popover depends on
// the AgentNavigator port (DIP), never on WKWebView/NSApp directly; in tests a
// spy records the id without driving AppKit.

import Cocoa
import WebKit

protocol AgentNavigator: AnyObject {
    func focus(agentId: String)
}

// Live navigator: runs the exact focus sequence the completion-notification tap
// already uses (app/main.swift:761-770) — reused verbatim, no new bridge.
// Reads the window/webView through closures so it always sees the current refs
// even if the window was closed and re-shown (background-app behaviour).
final class WebViewAgentNavigator: AgentNavigator {
    private let window: () -> NSWindow?
    private let webView: () -> WKWebView?
    private let ensureWindow: () -> Void

    init(window: @escaping () -> NSWindow?,
         webView: @escaping () -> WKWebView?,
         ensureWindow: @escaping () -> Void) {
        self.window = window
        self.webView = webView
        self.ensureWindow = ensureWindow
    }

    func focus(agentId: String) {
        NSApp.activate(ignoringOtherApps: true)
        // The window may have been closed while the app kept running in the menu
        // bar; bring it back before navigating.
        if window() == nil || window()?.isVisible == false { ensureWindow() }
        window()?.makeKeyAndOrderFront(nil)
        let escaped = agentId.replacingOccurrences(of: "'", with: "\\'")
        webView()?.evaluateJavaScript("window.__nativeNavigate?.('\(escaped)')")
    }
}
