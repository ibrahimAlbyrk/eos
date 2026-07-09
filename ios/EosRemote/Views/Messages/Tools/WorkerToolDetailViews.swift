import SwiftUI
import EosRemoteKit

// Worker-management + peer tool detail bodies (spec 03 §2.3/§2.4, port of WorkerToolCard.jsx bodies
// and the peer/message entries in ToolDetail.jsx). spawn/kill/message/get render a plain-text summary
// (with an optional loop-detail line on spawn); the list tools render AgentLink rows; create_worker is
// the blueprint card; list_available_workers the spawnable catalog; peers reuse the Q→A / report body.

// MARK: - §2.3 shared worker body (WorkerToolBody)

// The expanded body for spawn/kill/message/get/list_active_workers/list_pending_permissions. Rows-based
// list tools render click-to-select AgentLinks; the others render a plain-text summary. spawn's
// arm-at-spawn loop args get their own detail line above the prompt.
struct WorkerToolBodyView: View {
    let tool: Tool
    private var failure: Bool { tool.result?.isError == true }
    private var loopText: String? {
        (!failure && tool.name == "mcp__orchestrator__spawn_worker") ? spawnLoopDetails(tool.input["loop"]) : nil
    }
    private var rows: [WorkerRow]? {
        guard !failure else { return nil }
        switch tool.name {
        case "mcp__orchestrator__list_active_workers": return listWorkersRows(tool)
        case "mcp__orchestrator__list_pending_permissions": return pendingRows(tool)
        default: return nil
        }
    }
    private var emptyText: String {
        tool.name == "mcp__orchestrator__list_pending_permissions" ? "No pending permissions." : "No workers."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let loopText { WdText(text: loopText) }
            if isRowTool {
                rowsBody
            } else {
                ReportDetailText(text: workerToolDetailText(tool))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    }

    private var isRowTool: Bool {
        tool.name == "mcp__orchestrator__list_active_workers" ||
        tool.name == "mcp__orchestrator__list_pending_permissions"
    }

    @ViewBuilder private var rowsBody: some View {
        if let rows, !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in workerRow(r) }
            }
            .padding(.top, 4)
        } else {
            ReportDetailText(text: failure ? (tool.result?.text ?? "") : emptyText)
        }
    }

    // A single row: the worker name as a click-to-select AgentLink, "· {meta}" inline, sub on its own line.
    private func workerRow(_ r: WorkerRow) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 0) {
                AgentLinkView(ref: AgentRef(id: r.id, name: r.name ?? r.id))
                if !r.meta.isEmpty {
                    Text(" · \(r.meta)").font(EosFont.body).foregroundStyle(EosColor.inkSecondary)
                }
            }
            if !r.sub.isEmpty {
                Text(r.sub).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - §2.3 create_worker blueprint (CreateWorkerDetail)

// The new-worker blueprint: description → config chips (model/effort/mode/extends) + flags → when-to-use
// → Tools (allow/deny globs as +/− pills or "all tools") + editRegex → Instructions body (first 12 lines
// + "(+N more)"). The input IS the artifact so it renders fully while the call is still running.
struct CreateWorkerDetailView: View {
    let tool: Tool
    private let bodyPreviewLines = 12

    private var input: JSONValue { tool.input }
    private var cfg: [(String, String)] {
        [("model", "model"), ("effort", "effort"), ("permissionMode", "mode"), ("extends", "extends")]
            .compactMap { key, label in input[key]?.stringValue.map { (label, $0) } }
    }
    private var flags: [String] {
        var f: [String] = []
        if input["persistent"]?.boolValue == true { f.append("persistent") }
        if input["collaborate"]?.boolValue == true { f.append("collaborate") }
        return f
    }
    private var allow: [String] { input["toolsAllow"]?.arrayValue?.compactMap { $0.stringValue } ?? [] }
    private var deny: [String] { input["toolsDeny"]?.arrayValue?.compactMap { $0.stringValue } ?? [] }
    private var editRegex: String? { input["editRegex"]?.stringValue }
    private var hasScope: Bool { !allow.isEmpty || !deny.isEmpty || editRegex != nil }
    private var bodyLines: [String] { (input["body"]?.stringValue ?? "").components(separatedBy: "\n") }
    private var description: String? { input["description"]?.stringValue }
    private var whenToUse: String? { input["whenToUse"]?.stringValue }
    private var failure: FailureKind? { failureKind(tool) }
    private var hasAny: Bool {
        description != nil || !cfg.isEmpty || !flags.isEmpty || whenToUse != nil || hasScope
            || input["body"]?.stringValue?.isEmpty == false
    }

    var body: some View {
        if hasAny || failure != nil {
            WdCard {
                if let failure { FailureBanner(kind: failure, text: tool.result?.text ?? "") }
                if let description { WdDesc(text: description) }
                if !cfg.isEmpty || !flags.isEmpty { chipsSection }
                if let whenToUse { labelled("When to use") { WdText(text: whenToUse) } }
                if hasScope { toolsSection }
                if let body = input["body"]?.stringValue, !body.isEmpty { instructionsSection }
            }
        }
    }

    private var chipsSection: some View {
        WrapRow(items: chipItems) { item in
            if item.flag { WdChip(value: item.text, flag: true) }
            else { WdChip(keyLabel: item.key, value: item.text) }
        }
    }
    private struct ChipItem: Hashable { let key: String; let text: String; let flag: Bool }
    private var chipItems: [ChipItem] {
        cfg.map { ChipItem(key: $0.0, text: $0.1, flag: false) } + flags.map { ChipItem(key: "", text: $0, flag: true) }
    }

    private var toolsSection: some View {
        labelled("Tools") {
            VStack(alignment: .leading, spacing: 6) {
                WrapRow(items: toolPillItems) { item in ToolScopePill(glob: item.glob, deny: item.deny, all: item.all) }
                if let editRegex {
                    (Text("edits limited to ").foregroundStyle(EosColor.inkTertiary) + Text(editRegex).foregroundStyle(EosColor.inkSecondary))
                        .font(EosFont.codeSmall)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
    private struct ToolPillItem: Hashable { let glob: String; let deny: Bool; let all: Bool }
    private var toolPillItems: [ToolPillItem] {
        let allowItems = allow.isEmpty ? [ToolPillItem(glob: "all tools", deny: false, all: true)]
                                       : allow.map { ToolPillItem(glob: $0, deny: false, all: false) }
        return allowItems + deny.map { ToolPillItem(glob: $0, deny: true, all: false) }
    }

    private var instructionsSection: some View {
        labelled("Instructions") {
            VStack(alignment: .leading, spacing: 5) {
                Text(bodyLines.prefix(bodyPreviewLines).joined(separator: "\n"))
                    .font(EosFont.code).foregroundStyle(EosColor.inkSecondary).lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if bodyLines.count > bodyPreviewLines {
                    Text("(+\(bodyLines.count - bodyPreviewLines) more lines)")
                        .font(EosFont.codeSmall).foregroundStyle(EosColor.inkTertiary)
                }
            }
        }
    }

    private func labelled<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) { WdSectionLabel(text: label); content() }
    }
}

// .wd-tool: an allow (+glob, accent-ish), deny (−glob, err-ish) or "all tools" (surface) capability pill.
struct ToolScopePill: View {
    let glob: String
    var deny: Bool = false
    var all: Bool = false
    var body: some View {
        Text(deny ? "−\(glob)" : glob)
            .font(EosFont.codeSmall)
            .foregroundStyle(all ? EosColor.inkSecondary : (deny ? EosColor.State.failedDot : EosColor.State.runningDot))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(fill, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
    private var fill: Color {
        if all { return EosColor.bgSunken }
        return (deny ? EosColor.State.failedDot : EosColor.State.runningDot).opacity(0.12)
    }
}

// MARK: - §2.3 list_available_workers (AvailableWorkersDetail)

// The spawnable catalog: name (mono) + provenance badge (builtin/user/project/runtime) + whenToUse /
// description. "No available workers." empty.
struct AvailableWorkersDetailView: View {
    let tool: Tool
    private var entries: [JSONValue]? { failureKind(tool) == nil ? toolResultJSON(tool)?.arrayValue : nil }

    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if let entries {
            WdCard {
                if entries.isEmpty {
                    Text("No available workers.").font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
                } else {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, e in entryRow(e) }
                }
            }
        }
    }

    private func entryRow(_ e: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(e["name"]?.stringValue ?? "")
                    .font(EosFont.code).fontWeight(.semibold).foregroundStyle(EosColor.ink)  // .awl-name mono 600 (§10)
                if let source = e["source"]?.stringValue, !source.isEmpty { ProvenanceBadge(source: source) }
            }
            let desc = e["whenToUse"]?.stringValue ?? e["description"]?.stringValue
            if let desc, !desc.isEmpty {
                Text(desc).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)       // .awl-desc fg-dim (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// .awl-source: provenance badge — builtin (neutral), user (accent), project (ok), runtime (warn).
struct ProvenanceBadge: View {
    let source: String
    private var colors: (fg: Color, bg: Color) {
        switch source {
        case "user":    return (EosColor.coral, EosColor.coral.opacity(0.16))
        case "project": return (EosColor.State.runningDot, EosColor.State.runningDot.opacity(0.16))
        case "runtime": return (EosColor.State.waitingDot, EosColor.State.waitingDot.opacity(0.18))
        default:        return (EosColor.inkSecondary, EosColor.inkTertiary.opacity(0.20))   // builtin
        }
    }
    var body: some View {
        Text(source)
            .font(EosFont.codeSmall).fontWeight(.semibold).kerning(0.3)
            .foregroundStyle(colors.fg)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(colors.bg, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

// MARK: - §2.4 peer + message bodies

// send_message_to_parent — the report text (report-detail body).
struct MessageDetailView: View {
    let tool: Tool
    var body: some View { ReportDetailText(text: tool.input["text"]?.stringValue ?? "") }
}

// ask_peer — the question + the peer's answer (Q→A, same chrome as ask_user).
struct PeerAskDetailView: View {
    let tool: Tool
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else {
            ToolQAView(items: [.init(question: tool.input["question"]?.stringValue ?? "",
                                     answer: (tool.result?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines))])
        }
    }
}

// respond_to_peer — the answer this worker gave a peer (report-detail body).
struct PeerRespondDetailView: View {
    let tool: Tool
    var body: some View { ReportDetailText(text: tool.input["answer"]?.stringValue ?? "") }
}

// list_peers — the consultable peer roster: "{name} · {state}" + specialty summary. "No peers available."
struct PeerListDetailView: View {
    let tool: Tool
    private var peers: [JSONValue]? { failureKind(tool) == nil ? toolResultJSON(tool)?.arrayValue : nil }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if let peers {
            ReportDetailText(text: peersBody(peers))
        }
    }
    private func peersBody(_ peers: [JSONValue]) -> String {
        guard !peers.isEmpty else { return "No peers available." }
        return peers.map { p in
            let head = [p["name"]?.stringValue, p["state"]?.stringValue]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            let summary = p["summary"]?.stringValue
            return (summary?.isEmpty == false) ? "\(head)\n\(summary!)" : head
        }.joined(separator: "\n\n")
    }
}
