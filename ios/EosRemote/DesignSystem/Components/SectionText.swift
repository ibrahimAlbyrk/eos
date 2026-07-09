import SwiftUI

// Two tiny text primitives (spec 02 §2.6).

// Muted, spaced, all-caps caption ("Recents", "ORCHESTRATORS").
struct SectionCaption: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title.uppercased())
            .font(EosFont.captionSmall)
            .tracking(0.6)
            .foregroundStyle(EosColor.inkTertiary)
            .padding(.horizontal, EosSpacing.xs)
            .padding(.top, EosSpacing.md)
            .padding(.bottom, EosSpacing.xxs)
    }
}

// Serif display heading for on-page groups.
struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(EosFont.heading)
            .foregroundStyle(EosColor.ink)
    }
}

#Preview("Section text") {
    VStack(alignment: .leading, spacing: EosSpacing.sm) {
        SectionHeader("Active workers")
        SectionCaption("Recents")
        SectionCaption("Orchestrators")
    }
    .padding(EosSpacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(maxHeight: .infinity)
    .background(EosColor.bg)
}
