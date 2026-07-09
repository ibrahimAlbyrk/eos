import SwiftUI
import EosRemoteKit

// Transcript dispatcher (spec 03 §1). Switches on the typed `Block.Payload`. Phase 4b-i wired the three
// TEXT centerpiece kinds (user / assistant / thinking); 4b-ii wires the Tier-1 TOOL / AGENT / REPORT
// tier — the universal tool chrome + detail bodies, diff hunks, tool groups, agent blocks, and the
// report/directive/peer rows (§5.3, §2.1/2.7, §5.8, §1 #4/#6/#7/#8/#9). The remaining kinds
// (terminal / loopCheck / git / system / worktree) stay CRUDE with `// Phase 4c:` markers.
struct MessageView: View {
    let block: Block

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
            MessageRowView(ts: block.ts, copyText: text, workerId: block.workerId) {
                MessageReportView(mode: .report, text: text,
                                  agent: AgentRef(id: fromWorker, name: workerName))  // §1 #7
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
            // Phase 4c: MessageLoopView collapsible system row (§1 #10).
            labeledRow("arrow.triangle.2.circlepath", "Dynamic loop", text, EosColor.State.waitingDot)
        case .loopCheck(let check):
            loopCheckLine(check)                                        // Phase 4c: LoopCheckLineView (§1 #11)
        case .terminal(let term):
            terminalCard(term)                                         // Phase 4c: TerminalCardView live-tail (§1 #12)
        case .deliveryFailed(let text):
            systemLine("exclamationmark.triangle", "message was not delivered — \"\(text)\"", EosColor.State.failedDot)  // Phase 4c
        case .cleared:
            systemLine("scissors", "conversation cleared", EosColor.inkTertiary)                                        // Phase 4c
        case .turnError(_, let message):
            systemLine("exclamationmark.triangle", message, EosColor.State.failedDot)                                   // Phase 4c
        case .gitPush(let ok, let message, let branch):
            gitLine(ok ? "arrow.up" : "exclamationmark.triangle", message, branch, ok)                                  // Phase 4c
        case .gitPull(let ok, let message, let branch):
            gitLine(ok ? "arrow.down" : "exclamationmark.triangle", message, branch, ok)                                // Phase 4c
        case .worktreePreserved(let path, let branch, let diffStat):
            worktreePreserved(path, branch, diffStat)                  // Phase 4c: WorktreePreservedView (§1 #18)
        }
    }

    // MARK: - Phase 4c crude renderers (kept until the Tier-2/3 cards land)

    private func loopCheckLine(_ check: LoopCheck) -> some View {
        let icon = check.met ? "checkmark" : (check.outcome == "escalated" ? "exclamationmark" : "circle.fill")
        let color = check.met ? EosColor.State.runningDot : (check.outcome == "escalated" ? EosColor.State.waitingDot : EosColor.inkTertiary)
        let attempt = check.attempt.map { a in "attempt \(a)" + (check.maxAttempts.map { "/\($0)" } ?? "") } ?? ""
        return HStack(spacing: EosSpacing.xxs) {
            Image(systemName: icon).foregroundStyle(color).font(.caption2)
            Text("Goal check\(attempt.isEmpty ? "" : " · \(attempt)")\(check.outcome.map { " · \($0)" } ?? "")")
            if !check.reason.isEmpty { Text("· \(check.reason)").foregroundStyle(EosColor.inkTertiary) }
        }
        .font(EosFont.mono).foregroundStyle(EosColor.inkSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func terminalCard(_ term: Terminal) -> some View {
        VStack(alignment: .leading, spacing: EosSpacing.xxs) {
            Text("❯ \(term.command)").font(EosFont.mono).foregroundStyle(EosColor.ink)
            if !term.output.isEmpty {
                Text(term.output).font(EosFont.mono).foregroundStyle(EosColor.inkSecondary).lineLimit(8)
            }
        }
        .padding(EosSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
    }

    private func worktreePreserved(_ path: String, _ branch: String, _ diffStat: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Worktree preserved").font(EosFont.caption).fontWeight(.semibold).foregroundStyle(EosColor.State.waitingDot)
            Text("\(branch) · \(diffStat) · \(path)").font(EosFont.captionSmall).foregroundStyle(EosColor.inkSecondary)
        }
        .padding(EosSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
    }

    private func labeledRow(_ icon: String, _ label: String, _ body: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(label, systemImage: icon).font(EosFont.caption).foregroundStyle(color)
            if !body.isEmpty { Text(body).font(EosFont.body).foregroundStyle(EosColor.ink) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
