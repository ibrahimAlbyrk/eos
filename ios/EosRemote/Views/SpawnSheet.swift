import SwiftUI
import EosRemoteKit

// Spawn sheet (design §5.3): the large POST /workers, phone-shaped via progressive disclosure.
// Primary: prompt, dir, model + effort. Advanced behind a disclosure. Spawn = SE step-up.
struct SpawnSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var prompt = ""
    @State private var cwd = ""
    @State private var model_ = "claude-opus-4-8"
    @State private var effort = "medium"
    @State private var showAdvanced = false
    @State private var toolsAllow = ""
    @State private var toolsDeny = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("Prompt", text: $prompt, axis: .vertical).lineLimit(2...8)
                }
                Section("Where") {
                    TextField("Directory", text: $cwd)
                }
                Section("Model") {
                    Picker("Model", selection: $model_) {
                        Text("Opus 4.8").tag("claude-opus-4-8")
                        Text("Sonnet 4.6").tag("claude-sonnet-4-6")
                        Text("Haiku 4.5").tag("claude-haiku-4-5-20251001")
                    }
                    Picker("Effort", selection: $effort) {
                        ForEach(["low", "medium", "high"], id: \.self) { Text($0).tag($0) }
                    }
                }
                DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                    TextField("toolsAllow (comma-sep)", text: $toolsAllow)
                    TextField("toolsDeny (comma-sep)", text: $toolsDeny)
                }
            }
            .navigationTitle("Spawn")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Spawn") { Task { await spawn() }; dismiss() }
                        .disabled(prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func spawn() async {
        var obj: [String: JSONValue] = [
            "prompt": .string(prompt),
            "model": .string(model_),
            "effort": .string(effort),
        ]
        if !cwd.isEmpty { obj["cwd"] = .string(cwd) }
        if !toolsAllow.isEmpty { obj["toolsAllow"] = .array(splitList(toolsAllow)) }
        if !toolsDeny.isEmpty { obj["toolsDeny"] = .array(splitList(toolsDeny)) }
        await model.spawnWorker(body: .object(obj))
    }

    private func splitList(_ s: String) -> [JSONValue] {
        s.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }
    }
}
