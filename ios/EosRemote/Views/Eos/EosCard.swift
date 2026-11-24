import SwiftUI

// The card the Eos screens set their rows and fields in, as the Devices screen's cards.
struct EosCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: EosSpacing.xs, content: content)
            .padding(EosSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
                .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
    }
}

/// "3m 20s", "48s".
func eosDuration(ms: Int) -> String {
    let seconds = max(ms / 1000, 0)
    return seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
}

func eosCost(_ usd: Double) -> String { String(format: "$%.2f", usd) }
