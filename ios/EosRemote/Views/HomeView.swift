import SwiftUI
import EosRemoteKit

// Home / landing = the always-present top of the Fleet section (spec 02 §3.3): paper background,
// centered Sunburst + serif greeting, the re-skinned fleet list beneath, and a bottom Composer whose
// submit is a fast-path spawn (default model/effort) while `+` opens the full SpawnSheet.
struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @AppStorage("defaultModel") private var defaultModel = "claude-opus-4-8"
    @AppStorage("defaultEffort") private var defaultEffort = "medium"

    let onOpenWorker: (String) -> Void
    let onSpawnSheet: () -> Void

    @State private var draft = ""
    @State private var killTarget: Worker?
    @State private var showModelPicker = false

    var body: some View {
        List {
            hero
                .listRowInsets(EdgeInsets(top: EosSpacing.xxl, leading: EosSpacing.screenInset,
                                          bottom: EosSpacing.lg, trailing: EosSpacing.screenInset))
                .listRowSeparator(.hidden)
                .listRowBackground(EosColor.bg)

            if model.workers.isEmpty {
                Text("No workers yet")
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkTertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowSeparator(.hidden)
                    .listRowBackground(EosColor.bg)
            } else {
                if !model.orchestrators.isEmpty {
                    Section { fleetRows(model.orchestrators) } header: { SectionCaption("Orchestrators") }
                }
                Section { fleetRows(model.plainWorkers) } header: { SectionCaption("Workers") }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(EosColor.bg)
        .safeAreaInset(edge: .bottom) {
            Composer(text: $draft, placeholder: "Spawn a worker…",
                     model: defaultModel, effort: defaultEffort,
                     onModelTap: { showModelPicker = true },
                     onPlus: onSpawnSheet, onMic: nil,
                     trailing: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? .voice({})
                        : .send(submitSpawn, enabled: true))
                .padding(.horizontal, EosSpacing.screenInset)
                .padding(.bottom, EosSpacing.xs)
        }
        .confirmationDialog("Kill this worker?", isPresented: .constant(killTarget != nil),
                            titleVisibility: .visible, presenting: killTarget) { w in
            Button("Kill \(w.name)", role: .destructive) {
                Task { await model.kill(w.id) }; killTarget = nil
            }
            Button("Cancel", role: .cancel) { killTarget = nil }
        } message: { _ in Text("This stops the worker.") }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(model: $defaultModel, effort: $defaultEffort)
                .environmentObject(model)
        }
    }

    private var hero: some View {
        VStack(spacing: EosSpacing.lg) {
            Sunburst().fill(EosColor.coral).frame(width: 56, height: 56)
                .accessibilityHidden(true)
            Text("Hey there, \(AccountLabel.firstName)")
                .font(EosFont.display).tracking(-0.4)
                .foregroundStyle(EosColor.ink)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private func fleetRows(_ list: [Worker]) -> some View {
        ForEach(list) { w in
            Button { onOpenWorker(w.id) } label: { WorkerRowNew(worker: w) }
                .buttonStyle(.plain)
                .listRowBackground(EosColor.bg)
                .listRowSeparatorTint(EosColor.hairline)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { killTarget = w } label: { Label("Kill", systemImage: "xmark.octagon") }
                }
        }
    }

    // Fast-path spawn (spec 02 §3.3): take the draft as the prompt with the default model/effort —
    // the same body SpawnSheet builds. The `+` opens the full sheet for dir/tools/advanced.
    private func submitSpawn() {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        draft = ""
        let body: JSONValue = .object([
            "prompt": .string(prompt),
            "model": .string(defaultModel),
            "effort": .string(defaultEffort),
        ])
        Task { await model.spawnWorker(body: body) }
    }
}
