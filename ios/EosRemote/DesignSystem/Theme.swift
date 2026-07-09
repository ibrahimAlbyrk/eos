import SwiftUI

// Theme wiring (spec 02 §1.5). A single EosTheme value carried in the environment lets previews and
// a future dark theme swap palettes without touching call sites. For v1 it's an empty marker; the
// real win is the one root modifier that sets the paper background, the coral accent, and locks
// light mode.
struct EosTheme { /* v1: empty marker; palette is accessed via EosColor directly.
                     Reserved so a future dark theme is a value swap, not a call-site edit. */ }

private struct EosThemeKey: EnvironmentKey { static let defaultValue = EosTheme() }
extension EnvironmentValues { var eosTheme: EosTheme {
    get { self[EosThemeKey.self] } set { self[EosThemeKey.self] = newValue } } }

extension View {
    /// Root styling: paper background, coral accent, light-locked (§7).
    func eosTheme() -> some View {
        self
            .tint(EosColor.coral)                 // system controls, links, focus
            .background(EosColor.bg.ignoresSafeArea())
            .environment(\.eosTheme, EosTheme())
            .preferredColorScheme(.light)         // v1 ships light-only; dark: TODO (§4.1)
    }
}
