import SwiftUI

// Custom circular top chrome (spec 02 §3.4) replacing the system toolbar: a leading hamburger that
// opens the drawer, and a trailing slot the hosting screen fills (Pending on Home, Interrupt on
// WorkerDetail). Paper shows through — no toolbar bar or hairline. Host via `.eosTopChrome { … }`
// which applies it as a top `.safeAreaInset` so it stays put while content scrolls and slides with
// the drawer.
struct TopChrome<Trailing: View>: View {
    @EnvironmentObject private var sidebar: SidebarState
    private let trailing: Trailing

    init(@ViewBuilder trailing: () -> Trailing) { self.trailing = trailing() }

    var body: some View {
        HStack {
            CircularIconButton(systemName: "line.3.horizontal", diameter: 40, accessibilityLabel: "Menu") {
                sidebar.isOpen = true
            }
            Spacer()
            trailing
        }
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.vertical, EosSpacing.xs)
        .background(.clear)
    }
}

extension View {
    func eosTopChrome<Trailing: View>(@ViewBuilder trailing: @escaping () -> Trailing) -> some View {
        safeAreaInset(edge: .top) { TopChrome(trailing: trailing) }
    }
}
