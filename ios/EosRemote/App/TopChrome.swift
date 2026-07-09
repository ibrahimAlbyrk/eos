import SwiftUI

// Glass top chrome (spec 05 §2.2 / §3.1) replacing the system toolbar: a leading hamburger that opens
// the drawer, and a trailing slot the hosting screen fills (empty on Home, Interrupt on WorkerDetail).
// The two buttons are floating Liquid Glass (`glass: true`), wrapped in one GlassEffectContainer so
// they sample coherently; the BAR ITSELF has no background — the dark content bleeds under the notch
// and the glass buttons float over it (doc 04 §2.3). Host via `.eosTopChrome { … }` which applies it
// as a top `.safeAreaInset` so it stays put while content scrolls and slides with the drawer.
struct TopChrome<Trailing: View>: View {
    @EnvironmentObject private var sidebar: SidebarState
    private let trailing: Trailing

    init(@ViewBuilder trailing: () -> Trailing) { self.trailing = trailing() }

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack {
                CircularIconButton(systemName: "line.3.horizontal", diameter: 40, glass: true, accessibilityLabel: "Menu") {
                    sidebar.isOpen = true
                }
                Spacer()
                trailing
            }
        }
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.vertical, EosSpacing.xs)
    }
}

extension View {
    func eosTopChrome<Trailing: View>(@ViewBuilder trailing: @escaping () -> Trailing) -> some View {
        safeAreaInset(edge: .top) { TopChrome(trailing: trailing) }
    }
}
