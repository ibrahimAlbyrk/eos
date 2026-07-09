import SwiftUI

// Thin-outlined circle with a centered SF Symbol (spec 02 §2.1) — the top-chrome hamburger, ghost,
// interrupt, and per-message action icons. Outlined on paper by default; `filled` = solid black like
// the voice button. Every instance requires an explicit accessibilityLabel (icons alone are
// meaningless to VoiceOver).
struct CircularIconButton: View {
    let systemName: String
    var diameter: CGFloat = 40
    var filled: Bool = false
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(filled ? EosColor.black : EosColor.surface)
                    .overlay(
                        filled ? nil
                        : Circle().strokeBorder(EosColor.hairline, lineWidth: EosLine.button)
                    )
                Image(systemName: systemName)
                    .font(.system(size: diameter * 0.42, weight: .regular))
                    .foregroundStyle(filled ? EosColor.onDark : EosColor.ink)
            }
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("CircularIconButton") {
    HStack(spacing: EosSpacing.lg) {
        CircularIconButton(systemName: "line.3.horizontal", accessibilityLabel: "Menu") {}
        CircularIconButton(systemName: "plus", diameter: 32, accessibilityLabel: "Spawn options") {}
        CircularIconButton(systemName: "waveform", diameter: 44, filled: true, accessibilityLabel: "Voice input") {}
        CircularIconButton(systemName: "arrow.up", diameter: 52, filled: true, accessibilityLabel: "Send") {}
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
