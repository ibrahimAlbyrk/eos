import SwiftUI

// Which root surface the drawer selects (contract §B1). Drives RootView's root content.
enum SidebarSection: String { case code, devices }

// Presentational-only shell state shared between the drawer, its container, and the per-screen top
// chrome. Kept separate from AppModel — this holds no domain data, only which section is selected
// and whether the drawer is open.
@MainActor final class SidebarState: ObservableObject {
    @Published var isOpen = false
    @Published var section: SidebarSection = .code
}

// The left drawer that slides the current screen right, revealing the drawer behind a dim scrim.
// Contract §C1/D-18: the drawer is opaque and full-height edge-to-edge — no glass panel, no corner
// radius on the drawer itself (DrawerView paints its own bg and handles the safe area, §E3). Main
// content offsets right by the drawer width, clipped to a progress-driven corner + scrim. Edge-gated
// drag-to-open that does NOT steal NavigationStack back-swipes or List scrolls; interactive spring
// with a Reduce-Motion fallback.
struct SidebarContainer<Sidebar: View, Content: View>: View {
    @EnvironmentObject private var sidebar: SidebarState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var focusInSidebar: Bool

    let sidebarContent: Sidebar
    let content: Content
    init(@ViewBuilder sidebar: () -> Sidebar, @ViewBuilder content: () -> Content) {
        self.sidebarContent = sidebar()
        self.content = content()
    }

    @State private var dragX: CGFloat = 0
    @State private var containerWidth: CGFloat = 0

    private var drawerWidth: CGFloat { min(containerWidth * 0.85, 360) }
    // The revealed main content rounds to ≈ the physical screen corner so the peek edge sits
    // concentric with the device. 39 is a safe modern-iPhone value.
    private let deviceCornerRadius: CGFloat = 39

    // Offset while dragging is clamped to the drawer's width; when open (not dragging) it rests at
    // the full width. Progress 0…1 drives scrim alpha and the (progress-driven) corner radius.
    private var currentOffset: CGFloat {
        if dragX != 0 { return min(max(dragX, 0), drawerWidth) }
        return sidebar.isOpen ? drawerWidth : 0
    }
    private var progress: CGFloat { drawerWidth == 0 ? 0 : currentOffset / drawerWidth }

    var body: some View {
        ZStack(alignment: .leading) {
            // 0) BASE — dark bleeds under the notch/home-indicator even before content paints.
            EosColor.bg.ignoresSafeArea()

            // 1) DRAWER — opaque, pinned left, fixed width, full-height edge-to-edge (§C1). The
            //    DrawerView ignores the safe area itself and re-applies the insets manually (§E3).
            sidebarContent
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity, alignment: .top)
                // Fully hidden while closed — the top-chrome gradients over the main content are
                // deliberately translucent (§E1), so a live drawer layer would ghost through them.
                .opacity(progress > 0 ? 1 : 0)
                .accessibilityFocused($focusInSidebar)
                .accessibilityHidden(!sidebar.isOpen)

            // 2) MAIN — offset right when open, corner rounds AS it opens (progress-driven), scrim on
            //    top. No scale — the drawer reads cleaner without the seam.
            content
                .clipShape(RoundedRectangle(cornerRadius: deviceCornerRadius * progress, style: .continuous))
                .overlay(scrim)
                .shadow(color: .black.opacity(0.35), radius: 16, x: -4)
                .offset(x: currentOffset)
                .accessibilityHidden(sidebar.isOpen)
        }
        .background(GeometryReader { geo in
            Color.clear.onAppear { containerWidth = geo.size.width }
                .onChange(of: geo.size.width) { _, w in containerWidth = w }
        })
        .gesture(edgeDrag)
        .animation(reduceMotion ? .none : EosSpring.drawer, value: sidebar.isOpen)
        .animation(reduceMotion ? .none : EosSpring.drawer, value: dragX)
        .onChange(of: sidebar.isOpen) { _, open in
            // Move VoiceOver focus into the drawer on open.
            if open { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { focusInSidebar = true } }
        }
    }

    @ViewBuilder private var scrim: some View {
        EosColor.ink.opacity(0.28 * progress)
            .ignoresSafeArea()
            .allowsHitTesting(sidebar.isOpen)
            .onTapGesture { sidebar.isOpen = false }
            .accessibilityAction(named: "Close menu") { sidebar.isOpen = false }
            .accessibilityHidden(!sidebar.isOpen)
    }

    // Edge-gated: only translate when the drag starts in the screen-left gutter (< 24pt) or the
    // drawer is already open. Otherwise pass through so NavigationStack back-swipes and List scrolls
    // keep working.
    private var edgeDrag: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                guard sidebar.isOpen || value.startLocation.x < 24 else { return }
                let base = sidebar.isOpen ? drawerWidth : 0
                dragX = min(max(base + value.translation.width, 0), drawerWidth)
            }
            .onEnded { value in
                guard dragX != 0 || (!sidebar.isOpen && value.startLocation.x < 24) else { return }
                let predicted = value.predictedEndTranslation.width + (sidebar.isOpen ? drawerWidth : 0)
                let shouldOpen = currentOffset > drawerWidth * 0.33 || predicted > drawerWidth * 0.5
                dragX = 0
                sidebar.isOpen = shouldOpen
            }
    }
}
