import SwiftUI

// Glass top chrome for root screens: a leading hamburger that opens the drawer, an optional
// centered title (§H P3 contract — CodeListView passes "Code"), and a trailing slot the hosting
// screen fills. The buttons are floating Liquid Glass in one GlassEffectContainer so they sample
// coherently. Backdrop per §E1: a bg→clear gradient drawn under the bar, extended up under the
// status bar and 16pt below the bar row — content scrolls under and fades out; no hard clip, no
// opaque band. Host via `.eosTopChrome(title:) { … }` (a top `.safeAreaInset`, so it stays put
// while content scrolls and slides with the drawer).
struct TopChrome<Trailing: View>: View {
    @EnvironmentObject private var sidebar: SidebarState
    private let title: String?
    private let trailing: Trailing

    init(title: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.trailing = trailing()
    }

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
        .overlay {
            if let title {
                Text(title)
                    .font(EosFont.labelStrong)
                    .foregroundStyle(EosColor.ink)
                    .lineLimit(1)
                    .padding(.horizontal, 56)   // stay clear of the 40pt buttons either side
                    .allowsHitTesting(false)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.vertical, EosSpacing.xs)
        .background(alignment: .top) {
            LinearGradient(colors: [EosColor.bg, EosColor.bg.opacity(0.9), EosColor.bg.opacity(0)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.bottom, -EosSpacing.md)   // overshoot 16pt below the bar row (§E1)
                .ignoresSafeArea(edges: .top)
        }
    }
}

extension View {
    func eosTopChrome<Trailing: View>(title: String? = nil,
                                      @ViewBuilder trailing: @escaping () -> Trailing) -> some View {
        safeAreaInset(edge: .top) { TopChrome(title: title, trailing: trailing) }
    }
}
