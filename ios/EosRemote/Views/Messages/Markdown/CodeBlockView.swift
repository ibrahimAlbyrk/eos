import SwiftUI

// A fenced code block (spec 03 §5.1/§5.4/§6.5): dark card (github-dark-dimmed palette), horizontally
// scrollable, syntax-highlighted off the main actor + cached, with a copy button pinned top-right that
// swaps to a checkmark for 1.5s. A `mermaid` fence renders as this same source card plus a "diagram"
// affordance (§5.6) — no WKWebView in v1.
struct CodeBlockView: View {
    let language: String?
    let code: String

    private var isMermaid: Bool { (language?.lowercased() == "mermaid") }

    @State private var highlighted: AttributedString?
    @State private var copied = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal, showsIndicators: false) {
                Group {
                    if let highlighted {
                        Text(highlighted)
                    } else {
                        // Plain mono until the async highlight lands (§5.4 fallback path).
                        Text(code)
                            .font(EosFont.code)
                            .foregroundStyle(CodeHighlighter.codeCardText)
                    }
                }
                .textSelection(.enabled)
                .lineSpacing(3)                                   // pre line-height ~1.6 (§10 .md-prose pre)
                .padding(EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14))
                .frame(minWidth: 0, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            copyButton
                .padding(6)                                       // .code-copy-btn top6 right6 (§10)
        }
        .background(CodeHighlighter.codeCardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))   // pre radius 6 (§10)
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(CodeHighlighter.codeCardBorder, lineWidth: 1)
        )
        .overlay(alignment: .bottomLeading) { if isMermaid { diagramAffordance } }
        .task(id: code) {
            if let hit = CodeHighlighter.cached(code: code, language: language) {
                highlighted = hit
            } else {
                highlighted = await CodeHighlighter.highlight(code: code, language: language)
            }
        }
    }

    // 26×26 muted circular copy (§6.5). Always visible on iOS (no hover), tap → checkmark 1.5s.
    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = code
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                withAnimation(.easeOut(duration: 0.15)) { copied = false }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(copied ? EosColor.State.runningDot : CodeHighlighter.codeCardText.opacity(0.9))
                .frame(width: 26, height: 26)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : "Copy code")
    }

    // Small "diagram" chip on mermaid fences (§5.6) — signals it's a diagram source, not just code.
    private var diagramAffordance: some View {
        Label("diagram", systemImage: "chart.xyaxis.line")
            .font(EosFont.codeSmall)
            .foregroundStyle(CodeHighlighter.codeCardText.opacity(0.85))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Color.white.opacity(0.06), in: Capsule())
            .padding(8)
    }
}
