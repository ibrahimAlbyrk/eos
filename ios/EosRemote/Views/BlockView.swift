import SwiftUI
import EosRemoteKit

// One transcript block. The native renderer covers the common kinds; the design keeps a
// per-timeline WKWebView escape hatch (§3.3) for the costliest markdown/diff/tool cards, decided
// per-timeline — not wired here, this is the native baseline.
struct BlockView: View {
    let block: Block

    var body: some View {
        switch block.kind {
        case .user:
            bubble(align: .trailing, bg: Color.accentColor.opacity(0.15))
        case .assistant, .jsonl:
            bubble(align: .leading, bg: Color.secondary.opacity(0.08))
        case .thinking:
            label("brain", "Thinking", .secondary)
        case .tool, .toolGroup:
            label("wrench.and.screwdriver", block.text ?? "Tool", .blue)
        case .report:
            label("doc.text", block.text ?? "Report", .green)
        case .directive:
            label("arrow.down.circle", block.text ?? "Directive", .purple)
        case .peerRequest:
            label("person.2", block.text ?? "Peer request", .teal)
        case .exit, .deliveryFailed:
            label("exclamationmark.triangle", block.text ?? block.kind.rawValue, .red)
        default:
            label("circle", block.text ?? block.kind.rawValue, .secondary)
        }
    }

    private func bubble(align: HorizontalAlignment, bg: Color) -> some View {
        HStack {
            if align == .trailing { Spacer(minLength: 32) }
            Text(block.text ?? "")
                .padding(10)
                .background(bg, in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: .infinity, alignment: align == .trailing ? .trailing : .leading)
            if align == .leading { Spacer(minLength: 32) }
        }
    }

    private func label(_ icon: String, _ text: String, _ color: Color) -> some View {
        Label { Text(text).font(.callout) } icon: { Image(systemName: icon).foregroundStyle(color) }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
