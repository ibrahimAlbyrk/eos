import SwiftUI

// Run-state indicator (spec 02 §2.9), driven by EosRunState (§1.2). Evolves FleetView.StateChip:
// a bare dot for list rows, or a labeled chip for the detail header. Status is conveyed by color
// AND an accessibility label / visible text (never color-only in the detail chip).
struct StateDot: View {
    let state: String
    var labeled: Bool = false

    private var rs: EosRunState { EosRunState.from(state) }

    var body: some View {
        if labeled {
            HStack(spacing: 6) {
                Circle().fill(rs.dot).frame(width: 7, height: 7)
                Text(rs.label).font(EosFont.captionSmall)
            }
            .padding(.horizontal, EosSpacing.xs)
            .padding(.vertical, 3)
            .background(rs.soft, in: Capsule())
            .foregroundStyle(EosColor.ink)
        } else {
            Circle()
                .fill(rs.dot)
                .frame(width: 8, height: 8)
                .accessibilityLabel(rs.label)
        }
    }
}

#Preview("StateDot") {
    VStack(alignment: .leading, spacing: EosSpacing.md) {
        HStack(spacing: EosSpacing.lg) {
            ForEach(["RUNNING", "IDLE", "FAILED", "WAITING", "OTHER"], id: \.self) { s in
                StateDot(state: s)
            }
        }
        VStack(alignment: .leading, spacing: EosSpacing.xs) {
            ForEach(["RUNNING", "IDLE", "FAILED", "WAITING", "DELIVERED"], id: \.self) { s in
                StateDot(state: s, labeled: true)
            }
        }
    }
    .padding(EosSpacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(maxHeight: .infinity)
    .background(EosColor.bg)
}
