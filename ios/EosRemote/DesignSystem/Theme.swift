import SwiftUI

// Theme wiring (spec 02 §1.5). A single EosTheme value carried in the environment lets previews and
// a future dark theme swap palettes without touching call sites. For v1 it's an empty marker; the
// real win is the one root modifier that sets the paper background, the coral accent, and locks
// light mode.
struct EosTheme { /* empty marker; palette is accessed via EosColor directly.
                     Reserved so a future warm-cream light theme is a value swap, not a call-site edit. */ }

private struct EosThemeKey: EnvironmentKey { static let defaultValue = EosTheme() }
extension EnvironmentValues { var eosTheme: EosTheme {
    get { self[EosThemeKey.self] } set { self[EosThemeKey.self] = newValue } } }

extension View {
    /// Root styling (v2): dark background, cornflower accent, DARK-ONLY.
    func eosTheme() -> some View {
        self
            .tint(EosColor.coral)                       // system controls, links, focus (now blue)
            .background(EosColor.bg.ignoresSafeArea())  // dark bleeds under the notch (bug 1)
            .environment(\.eosTheme, EosTheme())
            .preferredColorScheme(.dark)                // v2 is dark-only (was .light)
            // light: TODO — a later warm-cream (#f6f1e6) theme is a value swap in Colors.swift + a
            // colorScheme branch; structure the tokens now, don't build it.
    }
}
