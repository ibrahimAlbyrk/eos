import SwiftUI

// The trailing button's role: a solid-black voice waveform (idle) or a send arrow (text present).
enum ComposerTrailing {
    case voice(() -> Void)
    case send(() -> Void, enabled: Bool)
}

// The signature card (spec 02 §2.3): a multiline growing text field with a `+` bottom-left, a
// ModelPill, an optional mic glyph, and a solid-black send/voice button bottom-right. One primitive
// serves both Home ("Spawn a worker…") and Worker detail ("Reply to <name>"); only the trailing
// button's role differs.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let model: String
    var effort: String?
    let onModelTap: () -> Void
    let onPlus: () -> Void
    var onMic: (() -> Void)?
    let trailing: ComposerTrailing

    var body: some View {
        VStack(spacing: EosSpacing.xs) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(EosFont.body)
                .lineLimit(1...6)                                   // grows to 6 lines then scrolls
                .tint(EosColor.coral)
                .frame(minHeight: 24, alignment: .topLeading)

            HStack(spacing: EosSpacing.sm) {                        // control row
                CircularIconButton(systemName: "plus", diameter: 32, accessibilityLabel: "Spawn options", action: onPlus)
                ModelPill(model: model, effort: effort, action: onModelTap)
                Spacer()
                if let onMic {
                    CircularIconButton(systemName: "mic", diameter: 32, accessibilityLabel: "Dictate", action: onMic)
                }
                trailingButton
            }
        }
        .padding(EosSpacing.md)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous)
                .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline)
        )
        .shadow(color: .black.opacity(0.04), radius: 12, y: 4)     // soft lift, not a hard border
    }

    @ViewBuilder private var trailingButton: some View {
        switch trailing {
        case .voice(let act):
            CircularIconButton(systemName: "waveform", diameter: 40, filled: true, accessibilityLabel: "Voice input", action: act)
        case .send(let act, let enabled):
            CircularIconButton(systemName: "arrow.up", diameter: 40, filled: true, accessibilityLabel: "Send", action: act)
                .opacity(enabled ? 1 : 0.35)
                .disabled(!enabled)
        }
    }
}

#Preview("Composer") {
    struct Harness: View {
        @State private var empty = ""
        @State private var typed = "Refactor the auth token flow"
        var body: some View {
            VStack(spacing: EosSpacing.lg) {
                // Home idle: voice trailing, no mic
                Composer(text: $empty, placeholder: "Spawn a worker…",
                         model: "claude-opus-4-8", effort: "high",
                         onModelTap: {}, onPlus: {}, onMic: nil,
                         trailing: .voice({}))
                // Detail with text: send trailing + mic
                Composer(text: $typed, placeholder: "Reply to refactor-auth",
                         model: "claude-sonnet-5", effort: nil,
                         onModelTap: {}, onPlus: {}, onMic: {},
                         trailing: .send({}, enabled: true))
            }
            .padding(EosSpacing.screenInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(EosColor.bg)
        }
    }
    return Harness()
}
