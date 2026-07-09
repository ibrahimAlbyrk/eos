import SwiftUI

// Sheet row primitive (contract §A3, ref IMG_4424): optional 22pt leading icon, title over an
// optional subtitle, trailing coral check when selected, hairline separator inset to the text edge
// so stacked rows read as one card.
struct SelectRow: View {
    let icon: String?
    let iconTint: Color
    let title: String
    let subtitle: String?
    let selected: Bool
    let action: () -> Void

    init(icon: String? = nil, iconTint: Color = EosColor.inkSecondary,
         title: String, subtitle: String? = nil, selected: Bool, action: @escaping () -> Void) {
        self.icon = icon
        self.iconTint = iconTint
        self.title = title
        self.subtitle = subtitle
        self.selected = selected
        self.action = action
    }

    private var separatorInset: CGFloat {
        EosSpacing.md + (icon != nil ? 22 + EosSpacing.sm : 0)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: EosSpacing.sm) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(iconTint)
                        .frame(width: 22)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(EosFont.label)
                        .foregroundStyle(EosColor.ink)
                    if let subtitle {
                        Text(subtitle)
                            .font(EosFont.caption)
                            .foregroundStyle(EosColor.inkSecondary)
                    }
                }
                Spacer(minLength: EosSpacing.xs)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(EosColor.coral)
                }
            }
            .padding(.horizontal, EosSpacing.md)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(EosColor.hairline)
                .frame(height: EosLine.hairline)
                .padding(.leading, separatorInset)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

#Preview("SelectRow") {
    VStack(spacing: 0) {
        SelectRow(title: "Fable 5",
                  subtitle: "For your toughest challenges · 1M", selected: true) {}
        SelectRow(title: "Opus 4.8",
                  subtitle: "For complex tasks · 200k", selected: false) {}
        SelectRow(icon: "checkmark.shield", iconTint: EosColor.coral,
                  title: "Accept edits",
                  subtitle: "Auto-approve file edits, ask for shell", selected: true) {}
        SelectRow(icon: "folder.badge.plus", title: "Browse…", selected: false) {}
    }
    .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
    .padding(EosSpacing.screenInset)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
