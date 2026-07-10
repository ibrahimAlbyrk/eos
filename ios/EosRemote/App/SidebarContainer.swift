import SwiftUI
import UIKit

// Which root surface the drawer selects (contract §B1). Drives RootView's root content.
enum SidebarSection: String { case code, devices }

// Presentational-only shell state shared between the drawer, its container, and the per-screen top
// chrome. Kept separate from AppModel — this holds no domain data, only which section is selected
// and whether the drawer is open.
@MainActor final class SidebarState: ObservableObject {
    @Published var isOpen = false
    @Published var section: SidebarSection

    // Restored section at launch (round 7); the drawer always relaunches closed.
    init(section: SidebarSection = .code) {
        self.section = section
    }
    // Root-screen flag mirrored by RootView (path.isEmpty): drag-to-open is disabled on pushed
    // screens so the NavigationStack back-swipe keeps working. Read live by the pan's delegate —
    // a value copy would go stale between SwiftUI update passes.
    var canDragOpen = true
}

// The left drawer that slides the current screen right, revealing the drawer behind a dim scrim.
// Contract §C1/D-18: the drawer is opaque and full-height edge-to-edge — no glass panel, no corner
// radius on the drawer itself (DrawerView paints its own bg and handles the safe area, §E3). Main
// content offsets right by the drawer width, clipped to a progress-driven corner + scrim. The panel
// tracks the finger 1:1 in both directions: closed, a horizontal-dominant rightward pan drags it
// out (root screens only — `canDragOpen` keeps NavigationStack back-swipes working on pushed
// screens); open, a horizontal pan anywhere drags it back. Release springs to the nearest state
// factoring release velocity. The pan is a UIKit recognizer (DrawerPan below), NOT a SwiftUI
// DragGesture: recognition must CANCEL the touches a row Button is tracking, or every pan that
// releases inside a full-width row also fires that row's push.
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
    @State private var isDragging = false
    @State private var containerWidth: CGFloat = 0

    private var drawerWidth: CGFloat { min(containerWidth * 0.85, 360) }
    // The revealed main content rounds to ≈ the physical screen corner so the peek edge sits
    // concentric with the device. 39 is a safe modern-iPhone value.
    private let deviceCornerRadius: CGFloat = 39

    // Offset tracks the finger while a pan is live (isDragging — a plain `dragX != 0` sentinel
    // would snap the panel the instant a close-drag reaches exactly 0); at rest it sits at 0 or
    // the full width. Progress 0…1 drives scrim alpha and the corner radius.
    private var currentOffset: CGFloat {
        if isDragging { return min(max(dragX, 0), drawerWidth) }
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
            //    top. No scale — the drawer reads cleaner without the seam. The rounding must be an
            //    edge-to-edge mask, NOT a bounds clip: clipShape cuts at the safe-area rect, which
            //    beheads every screen's §E1/E2 status-bar/home-strip bleed and lets the drop shadow
            //    below darken the exposed strips (the visible seam).
            content
                .mask {
                    RoundedRectangle(cornerRadius: deviceCornerRadius * progress, style: .continuous)
                        .ignoresSafeArea()
                }
                .overlay(scrim)
                // Shadow only while the drawer peeks: at rest it bleeds through the §E2 gradient's
                // semi-transparent home-strip pixels and re-darkens the seam the mask just fixed.
                .shadow(color: .black.opacity(0.35 * progress), radius: 16, x: -4)
                .offset(x: currentOffset)
                .accessibilityHidden(sidebar.isOpen)
        }
        .background(GeometryReader { geo in
            Color.clear.onAppear { containerWidth = geo.size.width }
                .onChange(of: geo.size.width) { _, w in containerWidth = w }
        })
        .gesture(DrawerPan(state: sidebar,
                           onChanged: { tx in
                               isDragging = true
                               let base = sidebar.isOpen ? drawerWidth : 0
                               dragX = min(max(base + tx, 0), drawerWidth)
                           },
                           onEnded: { tx, vx in
                               // Nearest state by where the pan was headed: project the release
                               // velocity (UIScrollView fast-deceleration factor) so a flick
                               // commits even from a small translation.
                               let base = sidebar.isOpen ? drawerWidth : 0
                               let projected = base + tx + vx * 0.1
                               sidebar.isOpen = projected > drawerWidth * 0.5
                               isDragging = false
                               dragX = 0
                           }))
        // While tracking, a near-immediate spring keeps the panel glued to the finger; on release
        // (and programmatic toggles) the drawer spring carries it to the resting state.
        .animation(reduceMotion ? .none : (isDragging ? EosSpring.drawerTracking : EosSpring.drawer),
                   value: currentOffset)
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
}

// The drawer pan as a UIKit recognizer. Recognition cancels in-flight Button touches
// (cancelsTouchesInView), so a pan that releases over a row never fires that row's action —
// the failure mode a pure SwiftUI DragGesture cannot avoid. Begin rules (delegate):
// horizontal-dominant only (vertical List scrolls stay untouched); closed → rightward + root
// screens only (canDragOpen guards NavigationStack back-swipes); open → any horizontal pan;
// declines when the touch sits inside a horizontally scrollable child (the filter-chips row).
private struct DrawerPan: UIGestureRecognizerRepresentable {
    let state: SidebarState
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat, CGFloat) -> Void   // translation.x, velocity.x

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(state) }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.maximumNumberOfTouches = 1
        g.delegate = context.coordinator
        return g
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        guard let view = recognizer.view else { return }
        let tx = recognizer.translation(in: view).x
        switch recognizer.state {
        case .changed:
            onChanged(tx)
        case .ended:
            onEnded(tx, recognizer.velocity(in: view).x)
        case .cancelled, .failed:
            onEnded(tx, 0)
        default:
            break
        }
    }

    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private let state: SidebarState
        init(_ state: SidebarState) { self.state = state }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pan = g as? UIPanGestureRecognizer, let view = pan.view else { return false }
            let t = pan.translation(in: view)
            guard abs(t.x) > abs(t.y) else { return false }
            if !state.isOpen {
                guard state.canDragOpen, t.x > 0 else { return false }
            }
            // Leave horizontal child scrollers (filter chips) their own pans.
            var v = view.hitTest(pan.location(in: view), with: nil)
            while let cur = v, cur !== view {
                if let sv = cur as? UIScrollView, sv.contentSize.width > sv.bounds.width + 1 {
                    return false
                }
                v = cur.superview
            }
            return true
        }

        // Simultaneous ONLY with scroll-view pans (so List scrolling is never blocked while the
        // direction is sampled). Everything else — crucially SwiftUI Button tap recognizers —
        // stays exclusive: when this pan recognizes, UIKit cancels the row's tap, which is the
        // whole reason the drawer pan is a UIKit recognizer.
        func gestureRecognizer(_ g: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            other.view is UIScrollView
        }
    }
}
