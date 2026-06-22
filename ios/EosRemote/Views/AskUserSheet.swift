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
                Section { Text(question).font(.body) }
                if !options.isEmpty {
                    Section("Options") {
                        ForEach(options, id: \.self) { opt in
                            Button { toggle(opt) } label: {
                                HStack {
                                    Text(opt)
                                    Spacer()
                                    if selected.contains(opt) { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    }
                }
                Section("Or type an answer") {
                    TextField("Free text…", text: $freeText, axis: .vertical).lineLimit(1...5)
                }
            }
            .navigationTitle("Question")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        var answers = Array(selected)
                        if !freeText.trimmingCharacters(in: .whitespaces).isEmpty { answers.append(freeText) }
                        Task { await model.answerQuestion(workerId: workerId, toolUseId: toolUseId, answers: answers) }
                        dismiss()
                    }.disabled(selected.isEmpty && freeText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func toggle(_ opt: String) {
        if selected.contains(opt) { selected.remove(opt) } else { selected.insert(opt) }
    }
}
