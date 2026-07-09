import SwiftUI

// Circular icon button with a centered SF Symbol (spec 02 §2.1, reglassed spec 05 §2.2).
// Three layers of use:
//  · content (default): opaque `surface` circle + hairline — per-message action icons, sit on content.
//  · `glass: true`: drops the fill + hairline, applies `.glassEffect(in: .circle)` — the top-chrome
//    hamburger/interrupt floating over the scrolling transcript.
//  · `filled: true`: a brand-tinted PROMINENT glass button (the composer send/interrupt primary).
// Every instance requires an explicit accessibilityLabel (icons alone are meaningless to VoiceOver).
struct CircularIconButton: View {
    let systemName: String
    var diameter: CGFloat = 40
    var filled: Bool = false
    var glass: Bool = false
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Group {
            if filled {
                // Brand-tinted prominent glass — the primary action (send/interrupt).
                Button(action: action) {
                    Image(systemName: systemName)
                        .font(.system(size: diameter * 0.42, weight: .semibold))
                        .frame(width: diameter, height: diameter)
                        .contentShape(Circle())
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(EosColor.coral)
            } else if glass {
                // Plain floating glass — top-chrome buttons.
                Button(action: action) {
                    Image(systemName: systemName)
                        .font(.system(size: diameter * 0.42, weight: .regular))
                        .foregroundStyle(EosColor.ink)
                        .frame(width: diameter, height: diameter)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
            } else {
                // Opaque content variant — sits on the content layer.
                Button(action: action) {
                    ZStack {
                        Circle()
                            .fill(EosColor.surface)
                            .overlay(Circle().strokeBorder(EosColor.hairline, lineWidth: EosLine.button))
                        Image(systemName: systemName)
                            .font(.system(size: diameter * 0.42, weight: .regular))
                            .foregroundStyle(EosColor.ink)
                    }
                    .frame(width: diameter, height: diameter)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("CircularIconButton") {
    HStack(spacing: EosSpacing.lg) {
        CircularIconButton(systemName: "line.3.horizontal", glass: true, accessibilityLabel: "Menu") {}
        CircularIconButton(systemName: "plus", diameter: 32, accessibilityLabel: "Attach") {}
        CircularIconButton(systemName: "stop.fill", diameter: 44, filled: true, accessibilityLabel: "Interrupt") {}
        CircularIconButton(systemName: "arrow.up", diameter: 52, filled: true, accessibilityLabel: "Send") {}
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
