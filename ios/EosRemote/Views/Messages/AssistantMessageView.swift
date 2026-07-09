import SwiftUI
import EosRemoteKit

// Assistant reply (spec 03 §1 #2, §5.1): full-width serif Markdown prose — the transcript centerpiece.
// Blur-in reveal on arrival (§6.1) via the reveal ledger, so only output that arrives after entry
// animates. Wrapped in MessageRowView (copy + timestamp). Code fences, tables, and lists are real view
// nodes inside MarkdownView (§5.1) with per-fence copy buttons + syntax highlighting (§5.4).
struct AssistantMessageView: View {
    let block: Block

    var body: some View {
        MessageRowView(ts: block.ts, copyText: text) {
            MarkdownView(source: text)
                .blurInReveal(blockKey: block.id)
        }
    }

    private var text: String {
        if case let .assistant(t) = block.payload { return t }
        return ""
    }
}
