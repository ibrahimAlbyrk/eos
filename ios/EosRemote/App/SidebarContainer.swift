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
    // Root-screen flag mirrored by RootView (path.isEmpty). On root screens drag-to-open works
    // from anywhere; on pushed screens the left-edge strip is left to the NavigationStack
    // back-swipe and only pans starting past it arm the drawer (round 10). Read live by the
    // pan's delegate — a value copy would go stale between SwiftUI update passes.
    var isAtRoot = true
}

// The revealed main content rounds to the physical screen corner so the peek edge sits concentric
// with the device (§C1). The bezel radius is only exposed via a private UIScreen key — guarded so a
// removed key degrades to the fallback, never crashes. 39 (iPhone-X-class) is the explicit fallback
// when the lookup is unavailable or returns 0 (square-corner screens still get a visible curve).
@MainActor private let deviceCornerRadius: CGFloat = {
    let key = "_displayCornerRadius"
    guard UIScreen.main.responds(to: NSSelectorFromString(key)),
          let r = UIScreen.main.value(forKey: key) as? CGFloat, r > 0 else { return 39 }
    return r
}()

// The left drawer that slides the current screen right, revealing the drawer as a darker surface
// under the elevated card. Contract §C1/D-18: the drawer is opaque and full-height edge-to-edge —
// no glass panel, no corner radius on the drawer itself (DrawerView paints its own bg and handles
// the safe area, §E3). Main content offsets right by the drawer width, masked to the constant
// device corner radius with a progress-faded rim + seam shadow (ref IMG_4423). The panel
// tracks the finger 1:1 in both directions: closed, a horizontal-dominant rightward pan drags it
// out (on pushed screens the left-edge strip stays with the NavigationStack back-swipe — see the
// delegate); open, a horizontal pan anywhere drags it back. Release springs to the nearest state
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

    // Offset tracks the finger while a pan is live (isDragging — a plain `dragX != 0` sentinel
    // would snap the panel the instant a close-drag reaches exactly 0); at rest it sits at 0 or
    // the full width. Progress 0…1 drives the rim and seam-shadow alpha.
    private var currentOffset: CGFloat {
        if isDragging { return min(max(dragX, 0), drawerWidth) }
        return sidebar.isOpen ? drawerWidth : 0
    }
    private var progress: CGFloat { drawerWidth == 0 ? 0 : currentOffset / drawerWidth }

    var body: some View {
        ZStack(alignment: .leading) {
            // 0) BASE — dark bleeds under the notch/home-indicator even before content paints.
            //    Matches the drawer's bgSunken: the card's corner notches reveal this layer past
            //    the drawer's right edge, and any other tone breaks the seam's continuity.
            EosColor.bgSunken.ignoresSafeArea()

            // 1) DRAWER — opaque, pinned left, fixed width, full-height edge-to-edge (§C1). The
            //    DrawerView ignores the safe area itself and re-applies the insets manually (§E3).
            sidebarContent
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity, alignment: .top)
                // Under-card dim that lifts as the drawer opens: darkest while the card covers it,
                // normal brightness at full open — so closing visibly darkens the drawer and
                // opening restores it.
                .overlay {
                    EosColor.black.opacity(min(1, 1.05 * (1 - progress)))
                        .ignoresSafeArea()
                        .allowsHitTesting(false)
                }
                // Fully hidden while closed — the top-chrome gradients over the main content are
                // deliberately translucent (§E1), so a live drawer layer would ghost through them.
                .opacity(progress > 0 ? 1 : 0)
                .accessibilityFocused($focusInSidebar)
                .accessibilityHidden(!sidebar.isOpen)

            // 2) MAIN — offset right when open. The card reads elevated OVER the darker drawer (ref
            //    IMG_4423): the corner radius is the CONSTANT device radius — scaling it with
            //    progress reads as a straight edge for most of the drag, and at rest the mask hides
            //    under the physical bezel precisely because it is concentric. A 1px light rim traces
            //    the rounded edge (the reference's corner shine) and the card is NOT dimmed — the
            //    drawer behind is the darker surface. The rounding must be an edge-to-edge mask, NOT
            //    a bounds clip: clipShape cuts at the safe-area rect, which beheads every screen's
            //    §E1/E2 status-bar/home-strip bleed and lets the drop shadow below darken the
            //    exposed strips (the visible seam).
            content
                .overlay(closeTapLayer)
                .mask {
                    RoundedRectangle(cornerRadius: deviceCornerRadius, style: .continuous)
                        .ignoresSafeArea()
                }
                .overlay {
                    RoundedRectangle(cornerRadius: deviceCornerRadius, style: .continuous)
                        .strokeBorder(.white.opacity(0.14 * min(progress * 3, 1)), lineWidth: 1)
                        .ignoresSafeArea()
                        .allowsHitTesting(false)
                }
                // Shadow only while the drawer peeks: at rest it bleeds through the §E2 gradient's
                // semi-transparent home-strip pixels and re-darkens the seam the mask just fixed.
                // Tight and faint per ref IMG_4423 — a whisper of depth at the seam, not a spread
                // gradient band over the drawer.
                .shadow(color: .black.opacity(0.18 * progress), radius: 5, x: -2)
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

    // Invisible tap-to-close target over the whole card (ref shows no dim on the card — the tone
    // separation comes from the drawer's darker bg + the rim + the seam shadow).
    @ViewBuilder private var closeTapLayer: some View {
        Color.clear
            .contentShape(Rectangle())
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
// horizontal-dominant only (vertical List scrolls stay untouched); closed → rightward, and on
// pushed screens (!isAtRoot) only when the touch STARTED past the left-edge strip that belongs
// to the NavigationStack back-swipe; open → any horizontal pan; declines when the touch sits
// inside a horizontally scrollable child (filter chips, code blocks).
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
        // Wider than the system's ~20pt interactive-pop zone so an edge back-swipe can never
        // land in drawer territory.
        private static let backSwipeEdgeWidth: CGFloat = 24
        private let state: SidebarState
        init(_ state: SidebarState) { self.state = state }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pan = g as? UIPanGestureRecognizer, let view = pan.view else { return false }
            let t = pan.translation(in: view)
            guard abs(t.x) > abs(t.y) else { return false }
            if !state.isOpen {
                guard t.x > 0 else { return false }
                // Pushed screens: leave the left-edge strip to the nav back-swipe. The finger
                // has already moved past the touch slop by shouldBegin, so subtract the
                // translation to test where the touch went DOWN, not where it is now.
                if !state.isAtRoot {
                    guard pan.location(in: view).x - t.x > Self.backSwipeEdgeWidth else { return false }
                }
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
