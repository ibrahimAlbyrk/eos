import SwiftUI
import EosRemoteKit

// Transcript dispatcher (spec 03 §1). Switches on the typed `Block.Payload`. Phase 4b-i wired the three
// TEXT centerpiece kinds (user / assistant / thinking); 4b-ii wired the Tier-1 TOOL / AGENT / REPORT
// tier; 4c-i wires the Terminal card + the Loop family (loop / loopCheck) — the terminal live-tail card
// (§1 #12 / §6.6) and the collapsible dynamic-loop row + the inline goal-check verdict marker
// (§1 #10/#11). The remaining kinds (git / system / worktree) stay CRUDE with `// Phase 4d:` markers.
struct MessageView: View {
    let block: Block
    @EnvironmentObject private var model: AppModel

    var body: some View {
        switch block.payload {
        case .user:
            UserMessageView(block: block, workerId: block.workerId)     // §1 #1 · §5.5 rich-text + rewind
        case .assistant:
            AssistantMessageView(block: block)                          // §1 #2 · §5.1 serif Markdown + blur-in
        case .thinking:
            ThinkingLineView(block: block)                              // §1 #3 · mono streaming reveal
        case .tool(let tool):
            ToolItemView(tool: tool)                                    // §1 #5 · §5.3 chrome + Detail bodies
        case .toolGroup(_, let summary, let tools):
            ToolGroupView(summary: summary, tools: tools)               // §1 #4 · §5.3 group disclosure
        case .agentRun(let run):
            AgentBlockView(run: run)                                    // §1 #6 · AgentBlock + AgentViewerSheet
        case .report(let text, let fromWorker, let workerName):
            // A workflow run-completion report (workerName == "workflow") renders as the standalone
            // WorkflowReportView (§3), NOT the AgentLink report row.
            if workerName == "workflow" {
                WorkflowReportView(text: text)
            } else {
                MessageRowView(ts: block.ts, copyText: text, workerId: block.workerId) {
                    MessageReportView(mode: .report, text: text,
                                      agent: AgentRef(id: fromWorker, name: workerName))  // §1 #7
                }
            }
        case .directive(let text, let fromParent, let parentName):
            MessageRowView(ts: block.ts, copyText: text, workerId: block.workerId) {
                MessageReportView(mode: .directive, text: text,
                                  agent: AgentRef(id: fromParent, name: parentName))  // §1 #8
            }
        case .peerRequest(let text, let fromWorker, let fromName):
            MessageRowView(ts: block.ts, copyText: text, workerId: block.workerId) {
                MessageReportView(mode: .peerRequest, text: text,
                                  agent: AgentRef(id: fromWorker, name: fromName))    // §1 #9
            }
        case .loop(let text):
            MessageLoopView(text: text)                                // §1 #10 · collapsible dynamic-loop row
        case .loopCheck(let check):
            LoopCheckLineView(check: check)                            // §1 #11 · inline goal-check verdict marker
        case .terminal(let term):
            // §1 #12 / §6.6 · mono card w/ live-tail + spinner. The stop button is best-effort → the
            // worker-interrupt path (no terminal-kill route on the iOS control tunnel); it only shows
            // while live+running. Fresh live blocks blur in (§6.1), matching the Mac's .fresh entrance.
            TerminalCardView(terminal: term, isLive: block.live,
                             onStop: block.live && !term.done
                                ? { Task { await model.interrupt(block.workerId) } } : nil)
                .blurInReveal(blockKey: block.id, isLive: block.live)
        case .deliveryFailed(let text):
            systemLine("exclamationmark.triangle", "message was not delivered — \"\(text)\"", EosColor.State.failedDot)  // Phase 4d
        case .cleared:
            systemLine("scissors", "conversation cleared", EosColor.inkTertiary)                                        // Phase 4d
        case .turnError(_, let message):
            systemLine("exclamationmark.triangle", message, EosColor.State.failedDot)                                   // Phase 4d
        case .gitPush(let ok, let message, let branch):
            gitLine(ok ? "arrow.up" : "exclamationmark.triangle", message, branch, ok)                                  // Phase 4d
        case .gitPull(let ok, let message, let branch):
            gitLine(ok ? "arrow.down" : "exclamationmark.triangle", message, branch, ok)                                // Phase 4d
        case .worktreePreserved(let path, let branch, let diffStat):
            worktreePreserved(path, branch, diffStat)                  // Phase 4d: WorktreePreservedView (§1 #18)
        }
    }

    // MARK: - Phase 4d crude renderers (kept until the Tier-3 system/git/worktree cards land)

    private func worktreePreserved(_ path: String, _ branch: String, _ diffStat: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Worktree preserved").font(EosFont.caption).fontWeight(.semibold).foregroundStyle(EosColor.State.waitingDot)
            Text("\(branch) · \(diffStat) · \(path)").font(EosFont.captionSmall).foregroundStyle(EosColor.inkSecondary)
        }
        .padding(EosSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
    }

    private func gitLine(_ icon: String, _ message: String, _ branch: String?, _ ok: Bool) -> some View {
        HStack(spacing: EosSpacing.xxs) {
            Image(systemName: icon).foregroundStyle(ok ? EosColor.State.runningDot : EosColor.State.failedDot).font(.caption2)
            Text(message)
            if let branch { Text(branch).foregroundStyle(EosColor.inkTertiary) }
        }
        .font(EosFont.mono).foregroundStyle(EosColor.inkSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func systemLine(_ icon: String, _ text: String, _ color: Color) -> some View {
        HStack(spacing: EosSpacing.xxs) {
            Image(systemName: icon).foregroundStyle(color).font(.caption2)
            Text(text).foregroundStyle(EosColor.inkSecondary)
        }
        .font(EosFont.mono)
        .frame(maxWidth: .infinity, alignment: .center)
    }
}
