import SwiftUI

// Blur-in reveal (spec 03 §6.1, port of blurInReveal.js + @keyframes msg-blur-in). A freshly arrived
// block fades from opacity 0 · blur(7) · offsetY(3) → 0 over 0.22s ease. History is seeded as already
// revealed via a ledger keyed `sessionId:blockKey`, so opening a transcript doesn't flash — only
// output arriving AFTER entry animates. Reduce Motion collapses the duration to 0.
//
// Per-word staggering (the Mac's WORD_DELAY_MS) is deliberately not reproduced: 100s of animated Text
// spans are expensive on iOS. §6.1 sanctions the per-block variant — the whole new block reveals.

@MainActor
final class RevealLedger: ObservableObject {
    // sessionId:blockKey of blocks already on screen (or seeded from history) → never animate again.
    private var revealed: Set<String> = []
    private var sessionId = ""
    // While false (right after open), NOTHING animates — the whole first page is history. The view
    // flips it true once entry settles, so only blocks arriving afterward blur in (§6.1 "seeded after
    // the first scroll settles"). This sidesteps any onAppear-vs-onChange ordering race on open.
    private var entrySettled = false

    // Bind the ledger to a transcript session (the open worker). Switching worker resets the window.
    func bind(sessionId: String) {
        guard sessionId != self.sessionId else { return }
        self.sessionId = sessionId
        revealed.removeAll()
        entrySettled = false
    }

    // Called by the view once the initial page has settled → later output animates.
    func markEntrySettled() { entrySettled = true }

    private func key(_ blockKey: String) -> String { "\(sessionId):\(blockKey)" }

    // Non-mutating query — is this block already revealed? During the entry window everything counts as
    // revealed (history), so nothing flashes on open; afterward, only previously-seen blocks are.
    func isRevealed(_ blockKey: String) -> Bool { !entrySettled || revealed.contains(key(blockKey)) }

    // Mark a block revealed (call from onAppear, NOT during body). Returns whether it was newly marked.
    @discardableResult
    func markRevealed(_ blockKey: String) -> Bool { revealed.insert(key(blockKey)).inserted }
}

// Applies the entrance to a block. The view decides `animate` from the ledger's non-mutating query at
// first appearance; the modifier starts blurred/offset and settles to identity on appear, then marks
// the block revealed so a re-mount (scroll recycle) doesn't re-animate.
private struct BlurInModifier: ViewModifier {
    let blockKey: String
    let isLive: Bool
    @EnvironmentObject private var ledger: RevealLedger
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var didDecide = false
    @State private var animating = false

    func body(content: Content) -> some View {
        content
            .opacity(animating && !shown ? 0 : 1)
            .blur(radius: animating && !shown ? 7 : 0)
            .offset(y: animating && !shown ? 3 : 0)
            .onAppear {
                // A live streaming block re-reveals its growth (keyed by text length upstream); a
                // durable block animates once iff it wasn't already revealed/seeded.
                if !didDecide {
                    didDecide = true
                    animating = (isLive || !ledger.isRevealed(blockKey)) && !reduceMotion
                }
                ledger.markRevealed(blockKey)
                guard animating, !shown else { shown = true; return }
                withAnimation(.easeOut(duration: 0.22)) { shown = true }
            }
    }
}

extension View {
    // `blockKey` identity is what the ledger tracks; `isLive` forces re-reveal for streaming tails.
    func blurInReveal(blockKey: String, isLive: Bool = false) -> some View {
        modifier(BlurInModifier(blockKey: blockKey, isLive: isLive))
    }
}
