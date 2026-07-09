import SwiftUI

// Rounded pill showing "Opus 4.8 · High", tappable to open the model/effort picker (spec 02 §2.2).
struct ModelPill: View {
    let model: String
    var effort: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: EosSpacing.xxs) {
                Text(shortModel(model))
                    .font(EosFont.label)
                if let effort {
                    Text(effort.capitalized)
                        .font(EosFont.caption)
                        .foregroundStyle(EosColor.inkSecondary)
                }
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(EosColor.inkSecondary)
            }
            .padding(.horizontal, EosSpacing.sm)
            .padding(.vertical, EosSpacing.xs)
            .background(EosColor.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
            .foregroundStyle(EosColor.ink)
        }
        .buttonStyle(.plain)
    }
}

// Maps the wire model ids to display names (mirrors SpawnSheet's picker tags). Unknown ids fall
// through to the raw string so a new backend model still renders something legible.
func shortModel(_ model: String) -> String {
    switch model {
    case "claude-opus-4-8":             return "Opus 4.8"
    case "claude-sonnet-5":             return "Sonnet 5"
    case "claude-haiku-4-5-20251001":   return "Haiku 4.5"
    default:                            return model
    }
}

#Preview("ModelPill") {
    VStack(spacing: EosSpacing.md) {
        ModelPill(model: "claude-opus-4-8", effort: "high") {}
        ModelPill(model: "claude-sonnet-5", effort: nil) {}
        ModelPill(model: "claude-haiku-4-5-20251001", effort: "low") {}
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
