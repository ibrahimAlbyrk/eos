import SwiftUI
import EosRemoteKit

// Worker detail (design §5.3): live transcript + streaming thinking, inline Approve/Deny + ask_user
// card, a composer → POST message, interrupt. Transcript blocks render the ~16 normalized kinds.
struct WorkerDetailView: View {
    @EnvironmentObject var model: AppModel
    let workerId: String
    @State private var draft = ""

    private var worker: Worker? { model.workers.first { $0.id == workerId } }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.hasOlder {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .onAppear { Task { await model.loadOlder() } }
                    }
                    ForEach(model.transcript) { BlockView(block: $0).id($0.id) }
                }
                .padding(.horizontal)
            }
            // Bottom anchor lands the newest message on open (framework computes the offset at layout,
            // so it survives the LazyVStack incremental race the old runloop hack lost to) and, on growth,
            // holds the bottom-relative position: follows new tail messages when parked at the bottom,
            // but leaves the reading spot untouched when scrolled up into history.
            .defaultScrollAnchor(.bottom)
            .task(id: workerId) { await model.openWorker(workerId) }
            composer
        }
        .navigationTitle(worker?.name ?? workerId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.interrupt(workerId) } } label: { Image(systemName: "stop.circle") }
            }
        }
        .onDisappear { model.closeWorker(workerId) }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message…", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            Button {
                let text = draft; draft = ""
                Task { await model.sendMessage(to: workerId, text: text) }
            } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(8)
        .background(.thinMaterial)
    }
}
