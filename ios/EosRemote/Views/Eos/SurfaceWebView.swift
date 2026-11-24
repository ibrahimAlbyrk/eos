import SwiftUI
import WebKit
import EosRemoteKit

// A Page issue on the phone (05 Q10, 07 §4.8): the Mac's one self-contained HTML document in a web
// view with JavaScript off and a content rule list that blocks every load but `data:` (its images
// and fonts), so the page reaches nothing. Its buttons are `eos-action:` links: intercepted here and
// handed to the native confirmation; every other navigation is refused.
struct SurfaceWebView: UIViewRepresentable {
    let html: String
    let onAction: (EosAction) -> Void

    /// Blocks every load, then lets `data:` through.
    static let rules = #"""
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}}]
    """#

    func makeCoordinator() -> Coordinator { Coordinator(onAction: onAction) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        let html = html
        // Nothing loads until the rules are in place.
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "eos-surface-offline",
                                                                encodedContentRuleList: Self.rules) { list, _ in
            guard let list else { return }
            view.configuration.userContentController.add(list)
            view.loadHTMLString(html, baseURL: nil)
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onAction = onAction
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var onAction: (EosAction) -> Void

        init(onAction: @escaping (EosAction) -> Void) { self.onAction = onAction }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if let press = EosAction.parse(url) {
                decisionHandler(.cancel)
                onAction(press)
                return
            }
            // The document itself (loaded as about:blank) and its own anchors; nothing else.
            let own = url.absoluteString == "about:blank" || url.absoluteString.hasPrefix("about:blank#")
            decisionHandler(own ? .allow : .cancel)
        }
    }
}

// The Page issue with its buttons: each press asks here first, then goes to the Mac's gate, which
// may ask again in its own words.
struct SurfaceDocumentView: View {
    @ObservedObject var feed: EosFeed
    let surfaceId: String
    let issueId: String

    @State private var html: String?
    @State private var failed = false
    @State private var pressed: EosAction?
    @State private var macAsks: (press: EosAction, token: String, prompt: String, typeToConfirm: String?)?
    @State private var typed = ""
    @State private var outcome: String?
    // One id per press: a repeat after Eos's confirmation names the same record.
    @State private var clientId = UUID().uuidString

    var body: some View {
        VStack(spacing: 0) {
            if let html {
                SurfaceWebView(html: html) { press in pressed = press }
            } else if failed {
                Text("This page could not be read from your Mac.")
                    .font(EosFont.body).foregroundStyle(EosColor.inkSecondary).padding()
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let outcome {
                Text(outcome).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary).padding(EosSpacing.sm)
            }
        }
        .background(EosColor.bg)
        .task {
            html = await feed.document(surfaceId: surfaceId, issueId: issueId)
            failed = html == nil
        }
        .confirmationDialog("Press “\(pressed?.button ?? "")”?", isPresented: .constant(pressed != nil),
                            titleVisibility: .visible, presenting: pressed) { press in
            Button("Press") { pressed = nil; clientId = UUID().uuidString; send(press) }
            Button("Cancel", role: .cancel) { pressed = nil }
        } message: { _ in
            Text("Eos runs it on your Mac, as its rules allow.")
        }
        .alert(macAsks?.prompt ?? "", isPresented: .constant(macAsks != nil)) {
            if let name = macAsks?.typeToConfirm { TextField(name, text: $typed) }
            Button("Go ahead") {
                guard let asked = macAsks else { return }
                macAsks = nil
                send(asked.press, confirm: asked.token, typed: asked.typeToConfirm == nil ? nil : typed)
            }
            Button("Cancel", role: .cancel) { macAsks = nil }
        }
    }

    private func send(_ press: EosAction, confirm: String? = nil, typed: String? = nil) {
        outcome = nil
        Task {
            switch await feed.press(press.request(clientId: clientId, confirm: confirm, typed: typed)) {
            case .done: outcome = "Done."
            case .confirm(let token, let prompt, let name):
                self.typed = ""
                macAsks = (press, token, prompt, name)
            case .held: outcome = "It waits for you in Needs you."
            case .refused(let why): outcome = why
            }
        }
    }
}
