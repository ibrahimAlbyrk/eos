import SwiftUI
import EosRemoteKit

// One transcript block — the native baseline (spec 02 §3.7), lightly recolored onto the paper tokens.
// This is NOT the Phase-4 renderer: no markdown / syntax-highlighting / tool-card rendering here.
// Assistant prose is serif ink (no bubble); the user turn is a coral-wash bubble; the icon-label rows
// for tool/report/directive/etc. keep today's structure but tint from the state palette.
struct BlockView: View {
    let block: Block

    var body: some View {
        switch block.kind {
        case .user:
            userBubble
        case .assistant, .jsonl:
            assistantProse
        case .thinking:
            label("brain", block.text ?? "Thinking…", EosColor.inkSecondary)
        case .tool, .toolGroup:
            label("wrench.and.screwdriver", block.text ?? "Tool", EosColor.State.infoDot)
        case .report:
            label("doc.text", block.text ?? "Report", EosColor.State.runningDot)
        case .directive:
            label("arrow.down.circle", block.text ?? "Directive", EosColor.coral)
        case .peerRequest:
            label("person.2", block.text ?? "Peer request", EosColor.State.infoDot)
        case .exit, .deliveryFailed:
            label("exclamationmark.triangle", block.text ?? block.kind.rawValue, EosColor.State.failedDot)
        default:
            label("circle", block.text ?? block.kind.rawValue, EosColor.inkSecondary)
        }
    }

    // Assistant: full-width serif prose, no bubble — the heart of the aesthetic (spec 02 §3.7).
    private var assistantProse: some View {
        Text(block.text ?? "")
            .font(EosFont.bodySerif)
            .lineSpacing(4)
            .foregroundStyle(EosColor.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // User: right-aligned coral-wash bubble.
    private var userBubble: some View {
        HStack {
            Spacer(minLength: 32)
            Text(block.text ?? "")
                .font(EosFont.body)
                .foregroundStyle(EosColor.ink)
                .padding(EosSpacing.sm)
                .background(EosColor.coralWash, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
        }
    }

    private func label(_ icon: String, _ text: String, _ color: Color) -> some View {
        Label {
            Text(text).font(EosFont.body).foregroundStyle(EosColor.ink)
        } icon: {
            Image(systemName: icon).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
