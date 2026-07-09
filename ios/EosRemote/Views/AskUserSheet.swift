import SwiftUI
import EosRemoteKit

// ask_user sheet (design §5.3) — first-class, the orchestrator's only human channel. Question +
// options → POST /workers/:id/question-answer {toolUseId, answers}; multi-select + free-text.
struct AskUserSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let workerId: String
    let toolUseId: String
    let question: String
    let options: [String]

    @State private var selected: Set<String> = []
    @State private var freeText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section { Text(question).font(EosFont.bodySerif).foregroundStyle(EosColor.ink) }
                if !options.isEmpty {
                    Section("Options") {
                        ForEach(options, id: \.self) { opt in
                            Button { toggle(opt) } label: {
                                HStack {
                                    Text(opt).font(EosFont.body).foregroundStyle(EosColor.ink)
                                    Spacer()
                                    if selected.contains(opt) {
                                        Image(systemName: "checkmark").foregroundStyle(EosColor.coral)
                                    }
                                }
                            }
                            .accessibilityAddTraits(selected.contains(opt) ? [.isSelected] : [])
                        }
                    }
                }
                Section("Or type an answer") {
                    TextField("Free text…", text: $freeText, axis: .vertical).lineLimit(1...5)
                }
            }
            .scrollContentBackground(.hidden)
            .background(EosColor.bg)
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Question").font(EosFont.titleSerif).foregroundStyle(EosColor.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    PillButton("Send", style: .primary) {
                        var answers = Array(selected)
                        if !freeText.trimmingCharacters(in: .whitespaces).isEmpty { answers.append(freeText) }
                        Task { await model.answerQuestion(workerId: workerId, toolUseId: toolUseId, answers: answers) }
                        dismiss()
                    }
                    .opacity(selected.isEmpty && freeText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.35 : 1)
                    .disabled(selected.isEmpty && freeText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationBackground(EosColor.bg)
    }

    private func toggle(_ opt: String) {
        if selected.contains(opt) { selected.remove(opt) } else { selected.insert(opt) }
    }
}
