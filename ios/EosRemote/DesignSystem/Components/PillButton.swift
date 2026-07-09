import SwiftUI

// Solid warm-black capsule (spec 02 §2.4) — the "Spawn worker" / "New" primary, and the Approve
// action. Three styles: primary (black), coral, ghost (outlined).
enum PillStyle { case primary /* black */; case coral; case ghost /* outlined */ }

struct PillButton: View {
    let title: String
    var systemImage: String?
    var style: PillStyle = .primary
    let action: () -> Void

    init(_ title: String, systemImage: String? = nil, style: PillStyle = .primary, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.style = style
        self.action = action
    }

    private var fill: Color {
        switch style {
        case .primary: return EosColor.black
        case .coral:   return EosColor.coral
        case .ghost:   return .clear
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: EosSpacing.xs) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).font(EosFont.labelStrong)
            }
            .padding(.horizontal, EosSpacing.lg)
            .padding(.vertical, EosSpacing.sm)
            .foregroundStyle(style == .ghost ? EosColor.ink : EosColor.onDark)
            .background(fill, in: Capsule())
            .overlay(
                style == .ghost
                ? Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.button)
                : nil
            )
        }
        .buttonStyle(.plain)
    }
}

#Preview("PillButton") {
    VStack(spacing: EosSpacing.md) {
        PillButton("Spawn worker", systemImage: "plus", style: .primary) {}
        PillButton("Approve", style: .coral) {}
        PillButton("Deny", style: .ghost) {}
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
