import SwiftUI

// Circular monogram (spec 02 §2.7) — the sidebar "IA". Initials derive from the paired device/account
// label upstream; this primitive just renders what it's given.
struct Avatar: View {
    let initials: String
    var diameter: CGFloat = 36
    var background: Color = EosColor.coral

    var body: some View {
        Circle()
            .fill(background)
            .frame(width: diameter, height: diameter)
            .overlay(
                Text(initials)
                    .font(.system(size: diameter * 0.4, weight: .semibold))
                    .foregroundStyle(EosColor.onDark)
            )
            .accessibilityLabel("Account: \(initials)")
    }
}

#Preview("Avatar") {
    HStack(spacing: EosSpacing.lg) {
        Avatar(initials: "IA")
        Avatar(initials: "EOS", diameter: 48)
        Avatar(initials: "W", diameter: 28, background: EosColor.black)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
