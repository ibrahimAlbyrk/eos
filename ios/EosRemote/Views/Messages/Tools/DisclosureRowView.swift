import SwiftUI

// Disclosure row (spec 03 §6.3, port of DisclosureRow.jsx). A content-sized tap target (fit-content
// width, not the full row) that toggles `open`; a chevron rotates 90° on expand, and the expanded
// content unfolds downward from the header's bottom edge — the body's top-move insertion is clipped
// to its own container, so it never draws over the header text. No hover on iOS, so the Mac's
// verb/chevron brightening is dropped. The header closure owns its own layout; this wrapper only adds
// the trailing chevron and the collapse behavior.
struct DisclosureRowView<Header: View, Content: View>: View {
    @Binding var open: Bool
    var showChevron: Bool = true
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Round 5, item E: every transcript expansion funnels through this toggle. The
    // hosting scroll view (WorkerDetailView) listens so it can hold its size-change
    // anchor at .top for the animation — expansion grows DOWNWARD, the tapped row
    // stays put. Fired BEFORE the state change so the anchor lands first.
    @Environment(\.onDisclosureToggle) private var onDisclosureToggle

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                onDisclosureToggle()
                withAnimation(reduceMotion ? nil : EosSpring.chip) { open.toggle() }
            } label: {
                HStack(spacing: 5) {                                    // .tool-item-header gap 5 (§10)
                    header()
                    if showChevron {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(EosColor.inkTertiary)     // .ti-chev fg-faint (§10)
                            .rotationEffect(.degrees(open ? 90 : 0))   // rotate(90°) when expanded (§6.3)
                            .accessibilityHidden(true)                 // decorative; state rides the value below
                    }
                }
                .contentShape(Rectangle())                             // content-sized hit area (§6.3)
            }
            .buttonStyle(.plain)
            .disabled(!showChevron)
            // One AX element per header row (VoiceOver: one swipe stop reading the whole
            // "verb file summary badge" line, instead of 5-7 fragments per tool row — which is
            // also what ballooned the XCUITest snapshot tree on long transcripts). Child taps
            // (AgentLink, file chip) surface as custom actions; expand state is the value.
            .accessibilityElement(children: .combine)
            .accessibilityValue(showChevron ? (open ? "expanded" : "collapsed") : "")

            // The body gets its own clipped container: its height animates 0↔fit while the top-move
            // insertion slides the content down inside it. The clip pins the reveal window to the
            // header's bottom edge, so mid-animation the body emerges below the header instead of
            // sliding through it; collapse mirrors the same path back up.
            VStack(alignment: .leading, spacing: 0) {
                if open {
                    content()
                        .transition(.opacity.combined(with: .move(edge: .top)))  // §6.3 expanded transition
                }
            }
            .clipped()
        }
    }
}

// Notifies the hosting scroll container that a disclosure is about to change the
// transcript's height (default no-op: previews/gallery/sheets have no anchor to hold).
private struct DisclosureToggleKey: EnvironmentKey {
    static let defaultValue: @MainActor () -> Void = {}
}
extension EnvironmentValues {
    var onDisclosureToggle: @MainActor () -> Void {
        get { self[DisclosureToggleKey.self] }
        set { self[DisclosureToggleKey.self] = newValue }
    }
}
