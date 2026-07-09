import SwiftUI
import EosRemoteKit

// Transcript dispatcher (spec 03 §1). Switches on the typed `Block.Payload` and dispatches each of the
// ~22 block kinds to its real renderer — the text centerpiece (user / assistant / thinking), the Tier-1
// tool / agent / report tier, the Terminal card + Loop family (§1 #10–#12), and the Tier-3 long tail:
// the system markers (deliveryFailed / cleared / turnError, §1 #13–#15 → SystemLineView), the git
// records (push / pull, §1 #16/#17 → GitLineView), and the preserved-worktree card (§1 #18 →
// WorktreePreservedView). Every `Block.Payload` case resolves to a bespoke view — no crude fallbacks.
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
            SystemLineView(kind: .deliveryFailed(text: text))          // §1 #13 · mono failed-tint line
        case .cleared:
            SystemLineView(kind: .cleared)                            // §1 #14 · centered divider
        case .turnError(_, let message):
            SystemLineView(kind: .turnError(message: message))        // §1 #15 · `!` + humanized provider error
        case .gitPush(let ok, let message, let branch):
            GitLineView(direction: .push, ok: ok, message: message, branch: branch)   // §1 #16 · ↑ / ! record
        case .gitPull(let ok, let message, let branch):
            GitLineView(direction: .pull, ok: ok, message: message, branch: branch)   // §1 #17 · ↓ / ! record
        case .worktreePreserved(let path, let branch, let diffStat):
            WorktreePreservedView(path: path, branch: branch, diffStat: diffStat)     // §1 #18 · preserved-worktree card
        }
    }
}
