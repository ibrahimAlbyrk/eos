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
            ScrollViewReader { proxy in
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
                // Auto-scroll only when the NEWEST block changes (a fresh message), not when older
                // history prepends on scroll-up.
                .onChange(of: model.transcript.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
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
        .task(id: workerId) { await model.openWorker(workerId) }
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
