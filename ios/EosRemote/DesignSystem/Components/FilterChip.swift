import SwiftUI

// Code-list filter capsule with a count badge (contract §C2, ref IMG_4434): All n · Running n ·
// Archived n. Selected flips to the light-on-dark fill (the reference's active chip). Fires
// Haptics.tap itself — chip select is the one §A5 haptic no screen spec wires.
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
                    .foregroundStyle(selected ? EosColor.black.opacity(0.6) : EosColor.inkTertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, EosSpacing.xs)
            .foregroundStyle(selected ? EosColor.black : EosColor.inkSecondary)
            .background(selected ? EosColor.ink : EosColor.surface2, in: Capsule())
            .overlay {
                if !selected {
                    Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline)
                }
            }
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
