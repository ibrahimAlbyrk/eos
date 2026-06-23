import SwiftUI
import EosRemoteKit

// Pending list (design §5.3): tool + input summary + TTL → POST /pending/:id/decision.
// Approve = SE step-up (no Face ID).
struct PendingListView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            ForEach(model.pending) { p in
                VStack(alignment: .leading, spacing: 6) {
                    Text(p.tool ?? "permission").font(.headline)
                    if let s = p.summary { Text(s).font(.callout).foregroundStyle(.secondary) }
                    HStack {
                        Button("Deny", role: .destructive) { Task { await model.approve(pendingId: p.id, allow: false) } }
                            .buttonStyle(.bordered)
                        Button("Approve") { Task { await model.approve(pendingId: p.id, allow: true) } }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(.vertical, 4)
            }
            if model.pending.isEmpty {
                ContentUnavailableView("No pending decisions", systemImage: "checkmark.shield")
            }
        }
        .navigationTitle("Pending")
    }
}
