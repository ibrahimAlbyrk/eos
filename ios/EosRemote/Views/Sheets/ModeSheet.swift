import SwiftUI

// Mode sheet (contract §C7, ref IMG_4430 anatomy): EXACTLY two rows — the Mac's two Eos
// permission modes (lib/permissionModes.jsx, master 18), not the reference's three. The owner
// decides what a pick means (local draft on NewSession, PUT /workers/:id/permission in the
// conversation) via the callback.
struct ModeSheet: View {
    @Environment(\.dismiss) private var dismiss

    let current: PermissionModeUI
    let onPick: (PermissionModeUI) -> Void

    init(current: PermissionModeUI, onPick: @escaping (PermissionModeUI) -> Void) {
        self.current = current
        self.onPick = onPick
    }

    var body: some View {
        VStack(spacing: 0) {
            EosSheetHeader("Select mode") { dismiss() }
            Group {
                row(.acceptEdits, tint: EosColor.coral)
                row(.bypassPermissions, tint: EosColor.State.violetDot)
            }
            .padding(.horizontal, EosSpacing.xs)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(EosColor.surface)
        .eosSheet(detents: [.height(280)])
    }

    private func row(_ mode: PermissionModeUI, tint: Color) -> some View {
        SelectRow(icon: mode.icon, iconTint: tint,
                  title: mode.label, subtitle: mode.subtitle,
                  selected: current == mode) {
            Haptics.tap()
            onPick(mode)
            dismiss()
        }
    }
}

#Preview("ModeSheet") {
    struct Harness: View {
        @State private var shown = true
        @State private var mode = PermissionModeUI.acceptEdits
        var body: some View {
            EosColor.bg.ignoresSafeArea()
                .sheet(isPresented: $shown) {
                    ModeSheet(current: mode) { mode = $0 }
                }
        }
    }
    return Harness()
}
