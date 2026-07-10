import SwiftUI

// The two-mode UI vocabulary (contract §C7, Mac lib/permissionModes.jsx). `icon`/`subtitle` feed
// the ModeSheet rows; the composer pill always draws the `</>` code glyph regardless of mode.
enum PermissionModeUI: String {
    case acceptEdits, bypassPermissions

    var label: String {
        switch self {
        case .acceptEdits:       return "Accept edits"
        case .bypassPermissions: return "Full Access"
        }
    }
    var icon: String {
        switch self {
        case .acceptEdits:       return "checkmark.shield"
        case .bypassPermissions: return "exclamationmark.shield"
        }
    }
    var subtitle: String {
        switch self {
        case .acceptEdits:       return "Auto-approve file edits, ask for shell"
        case .bypassPermissions: return "Auto-approve everything, including shell"
        }
    }
}

// Composer mode pill (contract §C3, ref IMG_4429 "</> Accept edits"): code glyph + current
// permission-mode label, tap opens ModeSheet. Surface-tinted interactive glass on the composer
// card — the same soft-dark tone as the attach circle beside it, not a pure-black solid.
struct ModePill: View {
    let mode: PermissionModeUI
    let action: () -> Void

    init(mode: PermissionModeUI, action: @escaping () -> Void) {
        self.mode = mode
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(EosColor.inkSecondary)
                Text(mode.label)
                    .font(EosFont.label)
            }
            .padding(.horizontal, EosSpacing.sm)
            .padding(.vertical, EosSpacing.xs)
            .foregroundStyle(EosColor.ink)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(EosColor.surface3).interactive(), in: .capsule)
        .accessibilityLabel("Permission mode: \(mode.label)")
    }
}

#Preview("ModePill") {
    VStack(spacing: EosSpacing.md) {
        ModePill(mode: .acceptEdits) {}
        ModePill(mode: .bypassPermissions) {}
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
