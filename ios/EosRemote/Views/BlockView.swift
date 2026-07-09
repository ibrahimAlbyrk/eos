import SwiftUI
import EosRemoteKit

// Transcript dispatcher (spec 03 §1). Switches on the typed `Block.Payload`. Phase 4b-i wires the
// three TEXT centerpiece kinds — user / assistant / thinking — to their rich views (§5.1/5.5, blur-in
// §6.1). The remaining kinds (tool / toolGroup / agentRun / report / …) stay CRUDE and keep their
// `// Phase 4b:` markers for 4b-ii.
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
            toolRow(tool)                                       // Phase 4b: ToolItemView chrome + Detail bodies
        case .toolGroup(_, let summary, let tools):
            toolGroup(summary, tools)                           // Phase 4b: ToolGroupView disclosure
        case .agentRun(let run):
            agentRun(run)                                       // Phase 4b: AgentBlockView + AgentViewerSheet
        case .report(let text, _, let workerName):
            labeledRow("doc.text", "Report" + (workerName.map { " from \($0)" } ?? ""), text, EosColor.State.runningDot)
        case .directive(let text, _, let parentName):
            labeledRow("arrow.down.circle", "Message" + (parentName.map { " from \($0)" } ?? ""), text, EosColor.coral)
        case .peerRequest(let text, _, let fromName):
            labeledRow("person.2", "Peer request" + (fromName.map { " from \($0)" } ?? ""), text, EosColor.State.infoDot)
        case .loop(let text):
            labeledRow("arrow.triangle.2.circlepath", "Dynamic loop", text, EosColor.State.waitingDot)
        case .loopCheck(let check):
            loopCheckLine(check)
        case .terminal(let term):
            terminalCard(term)                                  // Phase 4b: TerminalCardView live-tail + spinner
        case .deliveryFailed(let text):
            systemLine("exclamationmark.triangle", "message was not delivered — \"\(text)\"", EosColor.State.failedDot)
        case .cleared:
            systemLine("scissors", "conversation cleared", EosColor.inkTertiary)
        case .turnError(_, let message):
            systemLine("exclamationmark.triangle", message, EosColor.State.failedDot)
        case .gitPush(let ok, let message, let branch):
            gitLine(ok ? "arrow.up" : "exclamationmark.triangle", message, branch, ok)
        case .gitPull(let ok, let message, let branch):
            gitLine(ok ? "arrow.down" : "exclamationmark.triangle", message, branch, ok)
        case .worktreePreserved(let path, let branch, let diffStat):
            worktreePreserved(path, branch, diffStat)
        }
    }

    // A single tool: verb + name + running/failed hint. Phase 4b upgrades to the full chrome.
    private func toolRow(_ tool: Tool) -> some View {
        let failed = failureKind(tool)
        return HStack(spacing: EosSpacing.xxs) {
            Image(systemName: "wrench.and.screwdriver").foregroundStyle(EosColor.State.infoDot).font(.caption)
            Text(tool.running ? "Running" : "Used").foregroundStyle(EosColor.inkSecondary)
            Text(toolDisplayName(tool.name)).fontWeight(.semibold).foregroundStyle(EosColor.ink)
            if let failed { Text(failed.rawValue.uppercased()).font(EosFont.captionSmall).foregroundStyle(EosColor.State.failedDot) }
            Spacer(minLength: 0)
        }
        .font(EosFont.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // A tool group: the summary line + a crude list of member tools.
    private func toolGroup(_ summary: String, _ tools: [Tool]) -> some View {
        VStack(alignment: .leading, spacing: EosSpacing.xxs) {
            Label(summary.isEmpty ? "\(tools.count) tools" : summary, systemImage: "wrench.and.screwdriver")
                .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
            ForEach(tools) { t in
                Text("· \(toolDisplayName(t.name))")
                    .font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
                    .padding(.leading, EosSpacing.sm)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func agentRun(_ run: AgentRun) -> some View {
        VStack(alignment: .leading, spacing: EosSpacing.xxs) {
            Label(run.status == "running" ? "Running agent \(run.description)" : "Ran agent \(run.description)",
                  systemImage: "sparkles")
                .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
            if let result = run.result, !result.isEmpty {
                Text(result).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
                    .lineLimit(3).padding(.leading, EosSpacing.sm)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

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

    // A labeled report/directive/peer/loop row: bold label + body beneath.
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

    // Humanize an MCP tool name for the crude row (Phase 4b: the real per-tool label registry).
    private func toolDisplayName(_ name: String) -> String {
        if let last = name.components(separatedBy: "__").last, name.hasPrefix("mcp__") {
            return last.replacingOccurrences(of: "_", with: " ")
        }
        return name
    }
}
