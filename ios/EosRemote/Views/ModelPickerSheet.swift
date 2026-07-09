import SwiftUI

// Model / effort picker (spec 02 §3.9) opened by ModelPill's tap: a serif "Model" header, the three
// models as selectable rows (coral checkmark on selection), and a low/medium/high effort segment.
// Writes back the bound model/effort (the Home default via @AppStorage, or a spawn selection).
struct ModelPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var model: String
    @Binding var effort: String

    private let models = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"]

    var body: some View {
        VStack(alignment: .leading, spacing: EosSpacing.md) {
            Text("Model").font(EosFont.titleSerif).foregroundStyle(EosColor.ink)

            VStack(spacing: 0) {
                ForEach(models, id: \.self) { m in
                    Button { model = m } label: {
                        HStack {
                            Text(shortModel(m)).font(EosFont.label).foregroundStyle(EosColor.ink)
                            Spacer()
                            if model == m {
                                Image(systemName: "checkmark").foregroundStyle(EosColor.coral)
                            }
                        }
                        .padding(.vertical, EosSpacing.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(model == m ? [.isSelected] : [])
                    if m != models.last { Divider().overlay(EosColor.hairline) }
                }
            }
            .padding(.horizontal, EosSpacing.md)
            .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))

            Picker("Effort", selection: $effort) {
                ForEach(["low", "medium", "high"], id: \.self) { Text($0.capitalized).tag($0) }
            }
            .pickerStyle(.segmented)

            Spacer(minLength: 0)
        }
        .padding(EosSpacing.screenInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.bg)
        .presentationDetents([.height(280)])
        .presentationBackground(EosColor.bg)
    }
}
