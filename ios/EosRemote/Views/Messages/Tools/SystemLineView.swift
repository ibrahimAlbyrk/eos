import SwiftUI
import EosRemoteKit

// The Tier-3 system markers (spec 03 §1 #13/#14/#15, port of the inline `delivery-failed` /
// `conversation-cleared` / `turn-error` divs in Messages.jsx). All three are thin mono lines with no
// bubble and no action row — a transcript record of a lifecycle event. Geometry per §10:
//   • deliveryFailed — text-xs, failed tint, pad 4×0; "message was not delivered — "{text}" · try sending again".
//   • cleared        — text-xs, fg-dim, gap 10, pad 6×0; a centered "conversation cleared" between two hairlines.
//   • turnError      — text-xs, failed tint, bordered/washed card (radius 6, pad 6×10, gap 8); `!` + humanized message.
// State color is reserved for run-state (§0.3): a delivery/turn failure is a failure → failedDot tint.
enum SystemLineKind: Equatable {
    case deliveryFailed(text: String)
    case cleared
    case turnError(message: String)
}

struct SystemLineView: View {
    let kind: SystemLineKind

    var body: some View {
        switch kind {
        case .deliveryFailed(let text): deliveryFailed(text)
        case .cleared:                  cleared
        case .turnError(let message):   turnError(message)
        }
    }

    // .delivery-failed: text-xs, err, pad 4×0. The quoted body only appears when text is non-empty.
    private func deliveryFailed(_ text: String) -> some View {
        Text(deliveryText(text))
            .font(EosFont.codeSmall)                                            // mono text-xs (§10)
            .foregroundStyle(EosColor.State.failedDot)                          // failed tint (§10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)                                              // pad 4×0 (§10)
            .accessibilityLabel(deliveryText(text))
    }

    private func deliveryText(_ text: String) -> String {
        text.isEmpty
            ? "message was not delivered · try sending again"
            : "message was not delivered — “\(text)” · try sending again"     // em-quotes, matching the Mac
    }

    // .conversation-cleared: a centered label flanked by two flex:1 hairlines (::before/::after), gap 10.
    private var cleared: some View {
        HStack(spacing: 10) {                                                   // gap 10 (§10)
            hairline
            Text("conversation cleared")
                .font(EosFont.codeSmall)                                        // mono text-xs (§10)
                .foregroundStyle(EosColor.inkSecondary)                        // fg-dim (§10)
                .fixedSize()
            hairline
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)                                                  // pad 6×0 (§10)
        .accessibilityLabel("conversation cleared")
    }

    private var hairline: some View {
        Rectangle().fill(EosColor.hairline).frame(height: 1)                    // border-top hairline (§10)
    }

    // .turn-error: `!` icon (weight 600) + the humanized message, in a failed-washed bordered card.
    private func turnError(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {                     // gap 8 (§10)
            Text("!")
                .fontWeight(.semibold)                                          // te-icon weight 600 (§10)
                .foregroundStyle(EosColor.State.failedDot)
            Text(message)
                .foregroundStyle(EosColor.State.failedDot)                      // failed tint (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(EosFont.codeSmall)                                               // mono text-xs (§10)
        .padding(.horizontal, 10).padding(.vertical, 6)                        // pad 6×10 (§10)
        .background(EosColor.State.failedDot.opacity(0.04),                    // bg failed@4% (§10 tint→failed)
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
            .strokeBorder(EosColor.State.failedDot.opacity(0.12), lineWidth: 1)) // border failed@12% (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Turn error: \(message)")
    }
}
