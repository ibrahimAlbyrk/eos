import SwiftUI
import EosRemoteKit

// Worker detail (design §5.3): live transcript + streaming thinking, inline Approve/Deny + ask_user
// card, a composer → POST message, interrupt. Transcript blocks render the ~16 normalized kinds.
struct WorkerDetailView: View {
    @EnvironmentObject var model: AppModel
    let workerId: String
    @State private var draft = ""
    @State private var blocks: [Block] = []

    private var worker: Worker? { model.workers.first { $0.id == workerId } }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(blocks) { BlockView(block: $0).id($0.id) }
                    }
                    .padding(.horizontal)
                }
                .onChange(of: blocks.count) { _, _ in
                    if let last = blocks.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            composer
        }
        .navigationTitle(worker?.name ?? workerId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.interrupt(workerId) } } label: { Image(systemName: "stop.circle") }
            }
        }
        .task { /* TODO: load durable transcript via control GET /workers/:id/events (order:desc) */ }
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
