import SwiftUI

// Thin Settings stub (spec 02 §3.2) — a titled paper placeholder. Model defaults, appearance
// (reserved dark-mode toggle, §4.1), and about are filled in a later phase.
struct SettingsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.lg) {
                SectionHeader("Settings")
                Text("Model defaults, appearance, and about will live here.")
                    .font(EosFont.body)
                    .foregroundStyle(EosColor.inkSecondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.top, EosSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(EosColor.bg)
    }
}
