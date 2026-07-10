import SwiftUI

// Code-list filter capsule with a count badge (contract §C2, ref IMG_4434): All n · Running n ·
// Archived n. The active chip is a soft-dark surface capsule with light text; idle chips are
// translucent Liquid Glass. Fires Haptics.tap itself — chip select is the one §A5 haptic no
// screen spec wires.
struct FilterChip: View {
    let label: String
    let count: Int
    let selected: Bool
    let action: () -> Void

    init(_ label: String, count: Int, selected: Bool, action: @escaping () -> Void) {
        self.label = label
        self.count = count
        self.selected = selected
        self.action = action
    }

    var body: some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 6) {
                Text(label)
                    .font(EosFont.label)
                Text("\(count)")
                    .font(EosFont.captionSmall)
                    .foregroundStyle(selected ? EosColor.ink.opacity(0.6) : EosColor.inkTertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, EosSpacing.xs)
            .foregroundStyle(selected ? EosColor.ink : EosColor.inkSecondary)
            .background {
                if selected { Capsule().fill(EosColor.surfaceHi) }
            }
            .glassEffect(selected ? .identity : .regular.interactive(), in: .capsule)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label), \(count)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

#Preview("FilterChip") {
    HStack(spacing: EosSpacing.xs) {
        FilterChip("All", count: 12, selected: true) {}
        FilterChip("Running", count: 3, selected: false) {}
        FilterChip("Archived", count: 41, selected: false) {}
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
