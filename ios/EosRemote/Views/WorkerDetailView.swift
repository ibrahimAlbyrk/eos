import SwiftUI
import EosRemoteKit

// Worker detail (spec 02 §3.5): paper background, the transcript body (the lightly-recolored BlockView
// — the full Phase-4 renderer is NOT this phase), and the Composer primitive in place of the old
// composer. Keeps AppModel.openWorker/closeWorker, backward paging, and .defaultScrollAnchor(.bottom).
// Top chrome here is hamburger + Interrupt (stop.circle).
struct WorkerDetailView: View {
    @EnvironmentObject var model: AppModel
    let workerId: String
    @State private var draft = ""

    private var worker: Worker? { model.workers.first { $0.id == workerId } }
    private var name: String { worker?.name ?? workerId }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: EosSpacing.md) {
                if model.hasOlder {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, EosSpacing.xs)
                        .onAppear { Task { await model.loadOlder() } }
                }
                ForEach(model.transcript) { BlockView(block: $0).id($0.id) }
                TranscriptFoot()
            }
            .padding(.horizontal, EosSpacing.screenInset)
        }
        // Bottom anchor lands the newest message on open and holds the bottom-relative position on
        // growth (follows the tail at the bottom, leaves the reading spot when scrolled up).
        .defaultScrollAnchor(.bottom)
        .task(id: workerId) { await model.openWorker(workerId) }
        .onDisappear { model.closeWorker(workerId) }
        .background(EosColor.bg)
        .eosTopChrome {
            CircularIconButton(systemName: "stop.circle", diameter: 40, accessibilityLabel: "Interrupt") {
                Task { await model.interrupt(workerId) }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(text: $draft, placeholder: "Reply to \(name)",
                     model: worker?.model ?? "", effort: worker?.effort,
                     onModelTap: {}, onPlus: {}, onMic: nil,
                     trailing: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? .voice({})
                        : .send(send, enabled: true))
                .padding(.horizontal, EosSpacing.screenInset)
                .padding(.bottom, EosSpacing.xs)
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { await model.sendMessage(to: workerId, text: text) }
    }
}

// Transcript foot (spec 02 §3.5): the small Sunburst + an Eos-domain AI disclaimer (the risk here is
// actions taken, not answers).
struct TranscriptFoot: View {
    var body: some View {
        HStack(spacing: EosSpacing.xxs) {
            Sunburst().fill(EosColor.coral).frame(width: 13, height: 13)
                .accessibilityHidden(true)
            Text("Eos runs autonomous agents and can make mistakes. Review actions before approving.")
                .font(EosFont.caption)
                .foregroundStyle(EosColor.inkTertiary)
        }
        .padding(.vertical, EosSpacing.md)
    }
}
