import SwiftUI

// Disclosure row (spec 03 §6.3, port of DisclosureRow.jsx). A content-sized tap target (fit-content
// width, not the full row) that toggles `open`; a chevron rotates 90° on expand over 0.15s ease, and
// the expanded content transitions in with opacity + a top move. No hover on iOS, so the Mac's
// verb/chevron brightening is dropped. The header closure owns its own layout; this wrapper only adds
// the trailing chevron and the collapse behavior.
struct DisclosureRowView<Header: View, Content: View>: View {
    @Binding var open: Bool
    var showChevron: Bool = true
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(spacing: 5) {                                    // .tool-item-header gap 5 (§10)
                    header()
                    if showChevron {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(EosColor.inkTertiary)     // .ti-chev fg-faint (§10)
                            .rotationEffect(.degrees(open ? 90 : 0))   // rotate(90°) when expanded (§6.3)
                    }
                }
                .contentShape(Rectangle())                             // content-sized hit area (§6.3)
            }
            .buttonStyle(.plain)
            .disabled(!showChevron)

            if open {
                content()
                    .transition(.opacity.combined(with: .move(edge: .top)))  // §6.3 expanded transition
            }
        }
    }
}
