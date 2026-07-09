import SwiftUI

// The trailing button's role: a solid voice waveform (idle) or a send arrow (text present).
enum ComposerTrailing {
    case voice(() -> Void)
    case send(() -> Void, enabled: Bool)
}

// The floating glass composer (spec 05 §2.2 / doc 04 §3.2): a multiline growing text field with a
// `+` bottom-left, a ModelPill, an optional mic glyph, and a brand-tinted send/voice button. The whole
// card is ONE Liquid Glass surface (a single GlassEffectContainer) pinned to the bottom via the
// host's safeAreaInset — the `+`/ModelPill are content-on-glass, not their own glass (no glass-on-
// glass). One primitive serves both Home ("Spawn a worker…") and Worker detail ("Reply to <name>").
// Text-critical, so glass frosts to opaque under Reduce Transparency (doc 04 §5.3).
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let model: String
    var effort: String?
    let onModelTap: () -> Void
    let onPlus: () -> Void
    var onMic: (() -> Void)?
    let trailing: ComposerTrailing
    var focused: FocusState<Bool>.Binding?
    var disabled: Bool = false

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: EosSpacing.xs) {
                field
                HStack(spacing: EosSpacing.sm) {                        // control row (content-on-glass)
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
            .glassEffect(reduceTransparency ? .identity : .regular,
                         in: RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous))
            // Under Reduce Transparency `.identity` drops the glass with no fill, so paint an opaque
            // surface + hairline behind it to keep the field legible.
            .background {
                if reduceTransparency {
                    RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous)
                        .fill(EosColor.surface)
                        .overlay(RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous)
                            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
                }
            }
        }
        .opacity(disabled ? 0.5 : 1)
        .allowsHitTesting(!disabled)
    }

    @ViewBuilder private var field: some View {
        let tf = TextField(placeholder, text: $text, axis: .vertical)
            .font(EosFont.body)
            .lineLimit(1...6)                                   // grows to 6 lines then scrolls
            .tint(EosColor.coral)
            .frame(minHeight: 24, alignment: .topLeading)
        if let focused {
            tf.focused(focused)
        } else {
            tf
        }
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
        @FocusState private var focus: Bool
        var body: some View {
            VStack(spacing: EosSpacing.lg) {
                Spacer()
                // Home idle: voice trailing, no mic
                Composer(text: $empty, placeholder: "Spawn a worker…",
                         model: "claude-opus-4-8", effort: "high",
                         onModelTap: {}, onPlus: {}, onMic: nil,
                         trailing: .voice({}), focused: $focus)
                // Detail with text: send trailing + mic
                Composer(text: $typed, placeholder: "Reply to refactor-auth",
                         model: "claude-sonnet-5", effort: nil,
                         onModelTap: {}, onPlus: {}, onMic: {},
                         trailing: .send({}, enabled: true), focused: $focus)
            }
            .padding(EosSpacing.screenInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(EosColor.bg)
        }
    }
    return Harness()
}
