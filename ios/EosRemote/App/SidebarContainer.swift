import SwiftUI

// Which root surface the drawer selects (spec 02 §3.1/§3.2). Drives RootView's root content.
enum SidebarSection: String { case fleet, pending, devices, settings }

// Presentational-only shell state shared between the drawer, its container, and the per-screen top
// chrome (spec 02 §3.4 shows `sidebar.isOpen = true`). Kept separate from AppModel — this holds no
// domain data, only which section is selected and whether the drawer is open.
@MainActor final class SidebarState: ObservableObject {
    @Published var isOpen = false
    @Published var section: SidebarSection = .fleet
}

// The left drawer that slides the current screen right, revealing a rounded-corner "peek" behind a
// dim scrim (spec 02 §3.1). Not a NavigationSplitView — a custom overlay wrapping the existing
// NavigationStack. Edge-gated drag-to-open that does NOT steal NavigationStack back-swipes or List
// scrolls; interactive spring with a Reduce-Motion fallback.
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

    private var drawerWidth: CGFloat { min(containerWidth * 0.82, 340) }

    // Offset while dragging is clamped to the drawer's width; when open (not dragging) it rests at
    // the full width. Progress 0…1 drives scrim alpha, corner radius, and the peek scale.
    private var currentOffset: CGFloat {
        if dragX != 0 { return min(max(dragX, 0), drawerWidth) }
        return sidebar.isOpen ? drawerWidth : 0
    }
    private var progress: CGFloat { drawerWidth == 0 ? 0 : currentOffset / drawerWidth }

    var body: some View {
        ZStack(alignment: .leading) {
            // 1) SIDEBAR — underneath, pinned left, fixed width.
            sidebarContent
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity, alignment: .top)
                .accessibilityFocused($focusInSidebar)
                .accessibilityHidden(!sidebar.isOpen)

            // 2) MAIN — offset right when open, corner-rounded + scrim + subtle peek scale.
            content
                .background(EosColor.bg)
                .clipShape(RoundedRectangle(cornerRadius: sidebar.isOpen || dragX != 0 ? 24 : 0, style: .continuous))
                .overlay(scrim)
                .shadow(color: .black.opacity(0.12), radius: 16, x: -4)
                .offset(x: currentOffset)
                .scaleEffect(reduceMotion ? 1 : 1 - 0.03 * progress, anchor: .trailing)
                .accessibilityHidden(sidebar.isOpen)
        }
        .background(GeometryReader { geo in
            Color.clear.onAppear { containerWidth = geo.size.width }
                .onChange(of: geo.size.width) { _, w in containerWidth = w }
        })
        .gesture(edgeDrag)
        .animation(reduceMotion ? .none : .interactiveSpring(response: 0.35, dampingFraction: 0.86), value: sidebar.isOpen)
        .animation(reduceMotion ? .none : .interactiveSpring(response: 0.35, dampingFraction: 0.86), value: dragX)
        .onChange(of: sidebar.isOpen) { _, open in
            // Move VoiceOver focus into the drawer on open (spec 02 §4.2 focus management).
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
    // keep working (spec 02 §3.1).
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
