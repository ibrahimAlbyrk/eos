import SwiftUI
import EosRemoteKit

// Fleet root (design §5.3): orchestrators / workers split by is_orchestrator. Rows show a state
// chip, model·effort, live token/cost. A pinned pending banner; swipe trailing = Kill (confirm).
struct FleetView: View {
    @EnvironmentObject var model: AppModel
    @Binding var showSpawn: Bool
    @State private var killTarget: Worker?

    var body: some View {
        List {
            if !model.pending.isEmpty {
                Section { PendingBanner() }
            }
            if !model.orchestrators.isEmpty {
                Section("Orchestrators") { rows(model.orchestrators) }
            }
            Section("Workers") { rows(model.plainWorkers) }
        }
        .listStyle(.insetGrouped)
        .refreshable { /* foreground reconnect reconverges via snapshot */ }
        .confirmationDialog("Kill this worker?", isPresented: .constant(killTarget != nil),
                            titleVisibility: .visible, presenting: killTarget) { w in
            Button("Kill \(w.name)", role: .destructive) {
                Task { await model.kill(w.id) }; killTarget = nil
            }
            Button("Cancel", role: .cancel) { killTarget = nil }
        } message: { _ in Text("This stops the worker. Requires Face ID.") }
    }

    private func rows(_ list: [Worker]) -> some View {
        ForEach(list) { w in
            NavigationLink(value: w.id) { WorkerRow(worker: w) }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { killTarget = w } label: { Label("Kill", systemImage: "xmark.octagon") }
                }
        }
    }
}

struct WorkerRow: View {
    let worker: Worker
    var body: some View {
        HStack(spacing: 10) {
            StateChip(state: worker.state)
            VStack(alignment: .leading, spacing: 2) {
                Text(worker.name).font(.body.weight(.medium)).lineLimit(1)
                HStack(spacing: 6) {
                    if let m = worker.model { Text(m).font(.caption2) }
                    if let e = worker.effort { Text("· \(e)").font(.caption2) }
                    if let t = worker.tokens { Text("· \(t) tok").font(.caption2) }
                }.foregroundStyle(.secondary)
            }
            Spacer()
            if let c = worker.costUSD { Text(String(format: "$%.2f", c)).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 2)
    }
}

struct StateChip: View {
    let state: String
    private var color: Color {
        switch state {
        case "RUNNING", "WORKING": return .green
        case "IDLE", "DONE": return .secondary
        case "FAILED", "ERROR": return .red
        case "WAITING", "INPUT": return .orange
        default: return .blue
        }
    }
    var body: some View {
        Circle().fill(color).frame(width: 10, height: 10)
            .accessibilityLabel(state)
    }
}

struct PendingBanner: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        NavigationLink(value: "__pending__") {
            Label("\(model.pending.count) pending decision\(model.pending.count == 1 ? "" : "s")",
                  systemImage: "exclamationmark.shield")
                .foregroundStyle(.orange)
        }
    }
}
