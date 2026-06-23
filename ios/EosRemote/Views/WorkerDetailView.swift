import SwiftUI
import EosRemoteKit

// Worker detail (design §5.3): live transcript + streaming thinking, inline Approve/Deny + ask_user
// card, a composer → POST message, interrupt. Transcript blocks render the ~16 normalized kinds.
struct WorkerDetailView: View {
    @EnvironmentObject var model: AppModel
    let workerId: String
    @State private var draft = ""
    // True while the newest message is on screen — gates tail-follow so reading history isn't yanked.
    @State private var atBottom = true

    private let bottomID = "__transcript_bottom__"
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
                        // Tail anchor: tracks whether the user is parked at the newest message.
                        Color.clear.frame(height: 1).id(bottomID)
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .padding(.horizontal)
                }
                // A fresh tail message follows the bottom only if the user is already there.
                .onChange(of: model.transcript.last?.id) { _, _ in
                    if atBottom { withAnimation { proxy.scrollTo(bottomID, anchor: .bottom) } }
                }
                .task(id: workerId) {
                    atBottom = true
                    await model.openWorker(workerId)
                    await landAtBottom(proxy)   // anchor at newest once the list has laid out
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
        .onDisappear { model.closeWorker(workerId) }
    }

    // Land at the bottom on open. A LazyVStack lays out incrementally, so a single scrollTo on a long
    // transcript settles mid-list — re-anchor across a few runloop turns until it sticks at the newest.
    private func landAtBottom(_ proxy: ScrollViewProxy) async {
        proxy.scrollTo(bottomID, anchor: .bottom)
        for delayMs in [30, 120, 300] {
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            if Task.isCancelled { return }
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
        atBottom = true
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
