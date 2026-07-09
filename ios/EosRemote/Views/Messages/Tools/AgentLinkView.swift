import SwiftUI
import EosRemoteKit

// AgentLink (spec 03 §9, port of AgentLink.jsx + agentName.js). A tappable coral reference to another
// worker: single tap selects/navigates to it (iOS has no Cmd-click split — one behavior). The Mac
// resolves a durable name + a "· {definition}" suffix; here the name comes from the ref, falling back
// to a live-worker lookup, and the definition suffix renders faint when known.
struct AgentLinkView: View {
    let ref: AgentRef
    @EnvironmentObject private var model: AppModel
    @Environment(\.selectWorker) private var selectWorker

    private var worker: Worker? {
        if let id = ref.id { return model.workers.first { $0.id == id } }
        if let name = ref.name { return model.workers.first { $0.name == name } }
        return nil
    }
    private var displayName: String { ref.name ?? worker?.name ?? ref.id ?? "agent" }
    private var definition: String? {
        worker?.raw["worker_definition"]?.stringValue ?? worker?.raw["workerDefinition"]?.stringValue
    }

    var body: some View {
        Button {
            if let id = ref.id ?? worker?.id { selectWorker(id) }
        } label: {
            (Text(displayName).foregroundStyle(EosColor.coral).fontWeight(.semibold)
             + (definition.map { Text(" \($0)").foregroundStyle(EosColor.inkTertiary).fontWeight(.regular) }  // .ag-def (§10)
                ?? Text("")))
                .font(EosFont.label)
        }
        .buttonStyle(.plain)
        .disabled((ref.id ?? worker?.id) == nil)
        .accessibilityLabel("Open \(displayName)")
    }
}

// Environment hook: pushing a worker onto the nav path. Defaults to a no-op so previews / the gallery
// (no NavigationStack) don't crash; RootView supplies the real path-append. The closure is invoked from
// view tap handlers (main actor), so it's @MainActor-isolated to satisfy Swift 6 concurrency checking.
private struct SelectWorkerKey: EnvironmentKey {
    static let defaultValue: @MainActor (String) -> Void = { _ in }
}
extension EnvironmentValues {
    var selectWorker: @MainActor (String) -> Void {
        get { self[SelectWorkerKey.self] }
        set { self[SelectWorkerKey.self] = newValue }
    }
}
