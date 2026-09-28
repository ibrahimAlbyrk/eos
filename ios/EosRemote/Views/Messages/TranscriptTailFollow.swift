import SwiftUI

// Tail-follow for a bottom-anchored transcript ScrollView (conversation + terminal chat face).
//
// Rows live in a LazyVStack whose heights are estimates until they render, so a page that lands
// async keeps changing the content height well after open. The old fixed-delay re-scroll passes
// lost that race and could leave the viewport past the (since-shrunk) content end — a blank screen
// until the user scrolled. Here a sticky `pinned` flag is driven by scroll geometry instead: while
// pinned, every content-height change that leaves the viewport off the tail re-pins it, however
// late it comes. A user drag unpins; coming to rest at the tail pins again.
@MainActor
final class TranscriptTailFollow: ObservableObject {
    static let tailID = "transcript-tail"

    // Viewport more than a screen above the tail — drives the floating "↓" button.
    @Published fileprivate(set) var awayFromTail = false
    // Backward paging arms on the first user scroll, never during landing: a prepend fired
    // mid-landing is what used to strand the viewport off-content.
    @Published fileprivate(set) var pagingArmed = false
    // While a disclosure toggle animates, size changes anchor to .top so the tapped row stays put.
    @Published private(set) var disclosureHold = false
    // Bumped by jumpToTail(); the modifier performs the scroll (it owns the proxy + position).
    @Published fileprivate var jumpRequest = 0

    // Read only from scroll callbacks, never by a body — plain vars, so no re-render per event.
    fileprivate var pinned = true
    fileprivate var atTail = true
    fileprivate var userScrolling = false
    private var holdTask: Task<Void, Never>?

    // A newly opened conversation starts pinned to its tail.
    func reset() {
        pinned = true; atTail = true; userScrolling = false
        if pagingArmed { pagingArmed = false }
        if awayFromTail { awayFromTail = false }
    }

    func jumpToTail() { jumpRequest += 1 }

    fileprivate func holdForDisclosure() {
        disclosureHold = true
        // An expansion near the tail pushes it down; following would yank the reader off the row.
        pinned = false
        holdTask?.cancel()
        holdTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            disclosureHold = false
            pinned = atTail
        }
    }
}

extension View {
    // Apply to the transcript ScrollView inside its ScrollViewReader; the LazyVStack must end with
    // a view carrying `.id(TranscriptTailFollow.tailID)`.
    func transcriptTailFollow(_ follow: TranscriptTailFollow, proxy: ScrollViewProxy) -> some View {
        modifier(TailFollowModifier(follow: follow, proxy: proxy))
    }
}

private struct TailGeometry: Equatable {
    private static let tolerance: CGFloat = 8

    var atTail: Bool
    // Viewport beyond the content end: the content shrank under it (the blank-screen state).
    var pastEnd: Bool
    var away: Bool
    var contentHeight: CGFloat

    init(_ geo: ScrollGeometry) {
        let gap = geo.contentSize.height + geo.contentInsets.bottom
            - geo.contentOffset.y - geo.containerSize.height
        let scrollable = geo.contentSize.height + geo.contentInsets.top + geo.contentInsets.bottom
            > geo.containerSize.height
        atTail = !scrollable || abs(gap) <= Self.tolerance
        pastEnd = scrollable && gap < -Self.tolerance
        away = gap > geo.containerSize.height
        contentHeight = geo.contentSize.height.rounded()
    }
}

private struct TailFollowModifier: ViewModifier {
    @ObservedObject var follow: TranscriptTailFollow
    let proxy: ScrollViewProxy
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // Written only by the "↓" jump: its scrollTo(edge:) also stops an in-flight fling, which
    // proxy.scrollTo does not.
    @State private var position = ScrollPosition()

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(follow.disclosureHold ? .top : .bottom, for: .sizeChanges)
            .onScrollPhaseChange { _, phase in phaseChanged(phase) }
            .onScrollGeometryChange(for: TailGeometry.self, of: { TailGeometry($0) }) { old, new in
                geometryChanged(old, new)
            }
            .onChange(of: follow.jumpRequest) { jump() }
            .environment(\.onDisclosureToggle) { follow.holdForDisclosure() }
    }

    private func phaseChanged(_ phase: ScrollPhase) {
        switch phase {
        case .interacting:
            follow.userScrolling = true
            follow.pinned = false
            if !follow.pagingArmed { follow.pagingArmed = true }
        case .idle where follow.userScrolling:
            follow.userScrolling = false
            follow.pinned = follow.atTail
        default:
            break
        }
    }

    private func geometryChanged(_ old: TailGeometry, _ new: TailGeometry) {
        follow.atTail = new.atTail
        if new.away != follow.awayFromTail {
            if reduceMotion { follow.awayFromTail = new.away }
            else { withAnimation(EosSpring.chip) { follow.awayFromTail = new.away } }
        }
        guard !follow.userScrolling else { return }
        if new.pastEnd {
            pin()
        } else if new.atTail {
            follow.pinned = true
        } else if follow.pinned, !follow.disclosureHold, new.contentHeight != old.contentHeight {
            pin()
        }
    }

    private func pin() {
        follow.pinned = true
        proxy.scrollTo(TranscriptTailFollow.tailID, anchor: .bottom)
    }

    // Instant, not animated: an animated scroll across unrendered rows chases a target that moves
    // as their real heights land (the up/down stutter). Pinning absorbs whatever settling is left.
    // The proxy call covers a repeat jump, where an unchanged .bottom position is a no-op.
    private func jump() {
        follow.userScrolling = false
        follow.pinned = true
        position.scrollTo(edge: .bottom)
        proxy.scrollTo(TranscriptTailFollow.tailID, anchor: .bottom)
    }
}
