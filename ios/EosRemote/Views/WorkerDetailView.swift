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
    // Blur-in ledger (spec 03 §6.1): seeds the loaded history as already-revealed so only output
    // arriving after entry animates. Bound to workerId so each transcript seeds its own history.
    @StateObject private var reveal = RevealLedger()

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
                // Top-of-transcript task card (spec 03 §1 MessageTask): "Task from {parent}" + the boot
                // prompt, shown when this worker was spawned by an orchestrator (parent_id + prompt).
                if let worker, let parentId = worker.parentId, let prompt = worker.prompt, !prompt.isEmpty {
                    TaskFromView(prompt: prompt,
                                 parent: AgentRef(id: parentId,
                                                  name: model.workers.first { $0.id == parentId }?.name ?? "orchestrator"))
                        .padding(.bottom, EosSpacing.xs)
                }
                // Top-of-transcript status card for a worker's active dynamic loop (spec 03 §1 LoopStatus):
                // status + attempt + goal + last reason + last-5 attempt history. Absent when no loop.
                if let loop = worker?.loop {
                    LoopStatusCardView(loop: loop, history: model.loopHistory(for: workerId))
                        .padding(.bottom, EosSpacing.xs)
                }
                ForEach(model.transcript) { MessageView(block: $0).id($0.id) }
                // Foot activity anchor: the live goal-check line while a looped worker idles under an
                // active check (spec 03 §4.10 #4 / §1 GoalCheckLine); otherwise the ProcessingLine spark
                // (§6.2) — animated + elapsed while busy, static when idle.
                if let check = model.activeGoalCheck(for: workerId) {
                    GoalCheckLineView(check: check)
                        .padding(.top, EosSpacing.xxs)
                } else {
                    ProcessingLineView(busy: model.isBusy(workerId))
                        .padding(.top, EosSpacing.xxs)
                }
                TranscriptFoot()
            }
            .padding(.horizontal, EosSpacing.screenInset)
        }
        .environmentObject(reveal)
        // Bottom anchor lands the newest message on open and holds the bottom-relative position on
        // growth (follows the tail at the bottom, leaves the reading spot when scrolled up).
        .defaultScrollAnchor(.bottom)
        .task(id: workerId) {
            reveal.bind(sessionId: workerId)
            await model.openWorker(workerId)
            // Let the first page paint, then open the animation window so only later output blurs in.
            try? await Task.sleep(nanoseconds: 350_000_000)
            reveal.markEntrySettled()
        }
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
