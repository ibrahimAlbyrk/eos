import SwiftUI

// One drawer nav row (spec 02 §2.5): thin line-icon + label, an optional count badge (Pending), and
// a selected state (coral icon + subtle coral wash).
struct SidebarRow: View {
    let icon: String
    let title: String
    let isSelected: Bool
    var badge: Int?
    let action: () -> Void

    init(_ icon: String, _ title: String, isSelected: Bool, badge: Int? = nil, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.isSelected = isSelected
        self.badge = badge
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: EosSpacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(isSelected ? EosColor.coral : EosColor.ink)
                    .frame(width: 26)                                  // icon gutter aligns labels
                Text(title)
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.ink)
                Spacer()
                if let badge, badge > 0 {
                    Text("\(badge)")
                        .font(EosFont.captionSmall)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(EosColor.State.waitingSoft, in: Capsule())
                        .foregroundStyle(EosColor.State.waitingDot)
                }
            }
            .padding(.vertical, EosSpacing.sm)
            .padding(.horizontal, EosSpacing.xs)
            .background(isSelected ? EosColor.coralWash : .clear, in: RoundedRectangle(cornerRadius: EosRadius.chip))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview("SidebarRow") {
    VStack(alignment: .leading, spacing: 2) {
        SidebarRow("square.stack.3d.up", "Fleet", isSelected: true) {}
        SidebarRow("exclamationmark.bubble", "Pending", isSelected: false, badge: 3) {}
        SidebarRow("laptopcomputer", "Devices", isSelected: false) {}
        SidebarRow("gearshape", "Settings", isSelected: false) {}
    }
    .padding(EosSpacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(maxHeight: .infinity)
    .background(EosColor.bg)
}
