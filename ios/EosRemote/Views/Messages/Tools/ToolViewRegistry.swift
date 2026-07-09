import SwiftUI
import EosRemoteKit

// The tool-view descriptor + the `getToolView(name)` registry (spec 03 §2, port of toolViews.jsx VIEWS).
// A descriptor supplies the header label (done + running), an optional dim arg-summary, an optional
// file-chip path / AgentLink, an optional diff-stats chip, whether it expands, and the detail body.
// BASE = "Used {humanized}" + GenericToolCard; FALLBACK = BASE + argsSummary. ANY tool not registered
// resolves to FALLBACK — so every unknown MCP tool still renders "what it acted on" + the generic card.

struct HeaderBadge: Equatable { let text: String; let fg: Color; let bg: Color }

struct ToolDescriptor {
    // (verb, file) for the collapsed header — done vs. running variants.
    var label: (Tool) -> (verb: String, file: String)
    var runningLabel: (Tool) -> (verb: String, file: String)
    var summary: (Tool) -> String?          // dim args hint after the file
    var filePath: (Tool) -> String?         // makes `file` a tappable file chip
    var agentRef: (Tool) -> AgentRef?       // makes `file` a tappable AgentLink
    var headerBadge: (Tool) -> HeaderBadge? // right-edge pill
    var stats: (Tool) -> (add: Int, del: Int)?  // +add/-del chip
    var expandable: (Tool) -> Bool
    var detail: (Tool) -> AnyView

    init(label: @escaping (Tool) -> (verb: String, file: String),
         runningLabel: ((Tool) -> (verb: String, file: String))? = nil,
         summary: @escaping (Tool) -> String? = { _ in nil },
         filePath: @escaping (Tool) -> String? = { _ in nil },
         agentRef: @escaping (Tool) -> AgentRef? = { _ in nil },
         headerBadge: @escaping (Tool) -> HeaderBadge? = { _ in nil },
         stats: @escaping (Tool) -> (add: Int, del: Int)? = { _ in nil },
         expandable: @escaping (Tool) -> Bool = { _ in true },
         detail: @escaping (Tool) -> AnyView) {
        self.label = label
        self.runningLabel = runningLabel ?? label
        self.summary = summary; self.filePath = filePath; self.agentRef = agentRef
        self.headerBadge = headerBadge; self.stats = stats; self.expandable = expandable; self.detail = detail
    }
}

// The tool registry (spec 03 §2). Read/Edit/MultiEdit/Write/Bash (Tier 1) + the Tier-2 named cards
// (§2.2–2.6: user-interaction, worker/peer, task, workflow, misc built-ins) get bespoke labels +
// detail bodies; every other tool falls to the generic FALLBACK descriptor.
func getToolView(_ name: String) -> ToolDescriptor {
    switch name {
    // §2.1 file & shell
    case "Read":      return readDescriptor()
    case "Edit":      return editDescriptor()
    case "MultiEdit": return multiEditDescriptor()
    case "Write":     return writeDescriptor()
    case "Bash":      return bashDescriptor()
    case "Glob", "Grep": return searchDescriptor()
    // §2.2 web & user-interaction
    case "WebSearch": return simpleDescriptor("Searched the web", "Searching the web") { $0.input["query"]?.stringValue ?? "" }
    case "WebFetch":  return simpleDescriptor("Fetched", "Fetching") { hostOf($0.input["url"]?.stringValue) }
    case "AskUserQuestion": return askUserQuestionDescriptor()
    case "mcp__orchestrator__ask_user": return askUserDescriptor()
    case "mcp__orchestrator__notify_user": return notifyDescriptor()
    case "Skill": return skillDescriptor()
    // §2.3 worker-management
    case "mcp__orchestrator__spawn_worker": return spawnWorkerDescriptor()
    case "mcp__orchestrator__kill_worker",
         "mcp__orchestrator__message_worker",
         "mcp__orchestrator__get_worker": return workerActionDescriptor(name)
    case "mcp__orchestrator__list_active_workers": return listActiveWorkersDescriptor()
    case "mcp__orchestrator__list_pending_permissions": return listPendingPermissionsDescriptor()
    case "mcp__orchestrator__create_worker": return createWorkerDescriptor()
    case "mcp__orchestrator__list_available_workers": return availableWorkersDescriptor()
    // §2.4 peer
    case "mcp__worker__ask_peer": return peerAskDescriptor()
    case "mcp__worker__respond_to_peer": return peerRespondDescriptor()
    case "mcp__worker__list_peers": return peerListDescriptor()
    case "mcp__worker__send_message_to_parent": return sendToParentDescriptor()
    // §2.5 task-management
    case "TaskCreate": return taskCreateDescriptor()
    case "TaskUpdate": return taskUpdateDescriptor()
    case "TaskGet":    return taskGetDescriptor()
    case "TaskList":   return taskListDescriptor()
    case "TodoWrite":  return todoWriteDescriptor()
    // §2.6 other built-ins & workflow
    case "mcp__orchestrator__workflow": return workflowDescriptor()
    case "mcp__orchestrator__current_datetime", "mcp__worker__current_datetime": return datetimeDescriptor()
    case "ToolSearch": return toolSearchDescriptor()
    case "ScheduleWakeup": return scheduleWakeupDescriptor()
    case "TaskOutput": return taskOutputDescriptor()
    default:          return fallbackDescriptor()
    }
}

// MARK: - descriptors

private func readDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in
        let path = filePathOf(t)
        // A read of a SKILL.md → "{skill} SKILL" (§2.1).
        if path.hasSuffix("SKILL.md") {
            let skill = (path as NSString).deletingLastPathComponent
            return ("Read", "\((skill as NSString).lastPathComponent) SKILL")
        }
        return ("Read", basename(path))
    },
    runningLabel: { t in ("Reading", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    detail: { AnyView(ReadDetailView(tool: $0)) }) }

private func editDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Edit", basename(filePathOf(t))) },
    runningLabel: { t in ("Editing", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    stats: { editDiffStats($0) },
    detail: { AnyView(EditDetailView(tool: $0)) }) }

private func multiEditDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Edit", basename(filePathOf(t))) },
    runningLabel: { t in ("Editing", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    stats: { multiEditDiffStats($0) },
    detail: { AnyView(MultiEditDetailView(tool: $0)) }) }

private func writeDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Write", basename(filePathOf(t))) },
    runningLabel: { t in ("Writing", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    detail: { AnyView(WriteDetailView(tool: $0)) }) }

// Bash — git-aware done label ("Committed {sha}", "Pushed", "Viewed 2 diffs") else "Ran {cmd≤60}".
private func bashDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("", bashLabel(t)) },
    runningLabel: { t in ("", "Running \(clampCmd(commandOf(t)))") },
    detail: { AnyView(BashDetailView(tool: $0)) }) }

// FALLBACK — "Used {humanized}" + argsSummary; GenericToolCard body. Expandable only when there's a
// body to show (params/output/failure).
private func fallbackDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Used", humanizeToolName(t.name)) },
    runningLabel: { t in ("Running", humanizeToolName(t.name)) },
    summary: { argsSummary($0.input) },
    expandable: { t in
        (t.input.objectValue?.isEmpty == false) || (t.result?.text.isEmpty == false) || failureKind(t) != nil
    },
    detail: { AnyView(GenericToolCardView(tool: $0)) }) }

// MARK: - §2.1/§2.2 web & search descriptors

// Glob/Grep — BASE done label, "Searching {pattern/query}" while running (fallback detail).
private func searchDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Used", humanizeToolName(t.name)) },
    runningLabel: { t in ("Searching", t.input["pattern"]?.stringValue ?? t.input["query"]?.stringValue ?? "") },
    summary: { argsSummary($0.input) },
    detail: { AnyView(GenericToolCardView(tool: $0)) }) }

// A no-detail descriptor with a single verb + a file derived from input (WebSearch/WebFetch → fallback body).
private func simpleDescriptor(_ done: String, _ running: String,
                              _ file: @escaping (Tool) -> String) -> ToolDescriptor { ToolDescriptor(
    label: { t in (done, file(t)) },
    runningLabel: { t in (running, file(t)) },
    detail: { AnyView(GenericToolCardView(tool: $0)) }) }

// MARK: - §2.2 user-interaction descriptors

private func askUserQuestionDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Asked", "user") }, runningLabel: { _ in ("Asking", "user") },
    detail: { AnyView(AskUserQuestionDetailView(tool: $0)) }) }

private func askUserDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Asked", "user") }, runningLabel: { _ in ("Asking", "user") },
    detail: { AnyView(AskUserDetailView(tool: $0)) }) }

private func notifyDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Notified", "user") }, runningLabel: { _ in ("Notifying", "user") },
    detail: { AnyView(NotifyDetailView(tool: $0)) }) }

// Skill — "Used {skill} skill"; file chip from the parsed skill dir (skillPath).
private func skillDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Used", "\(t.input["skill"]?.stringValue ?? "skill") skill") },
    runningLabel: { t in ("Using", "\(t.input["skill"]?.stringValue ?? "skill") skill") },
    filePath: { t in (t.skillPath ?? parseSkillBody(t.skillBody).path) },
    detail: { AnyView(SkillDetailView(tool: $0)) }) }

// MARK: - §2.3 worker-management descriptors (verbs from WORKER_TOOL_SPECS; AgentLink targets)

private func spawnWorkerDescriptor() -> ToolDescriptor {
    let spec = WORKER_TOOL_SPECS["mcp__orchestrator__spawn_worker"]!
    return ToolDescriptor(
        label: { _ in (spec.verb, "") }, runningLabel: { _ in (spec.running, "") },
        agentRef: { workerIdentity($0) },
        headerBadge: { t in spawnLoopDetails(t.input["loop"]) != nil
            ? HeaderBadge(text: "loop", fg: EosColor.coral, bg: EosColor.coral.opacity(0.12)) : nil },  // .ti-loop-badge (§10)
        expandable: { workerExpandable($0) },
        detail: { AnyView(WorkerToolBodyView(tool: $0)) })
}

private func workerActionDescriptor(_ name: String) -> ToolDescriptor {
    let spec = WORKER_TOOL_SPECS[name]!
    return ToolDescriptor(
        label: { _ in (spec.verb, "") }, runningLabel: { _ in (spec.running, "") },
        agentRef: { workerIdentity($0) },
        expandable: { workerExpandable($0) },
        detail: { AnyView(WorkerToolBodyView(tool: $0)) })
}

private func listActiveWorkersDescriptor() -> ToolDescriptor {
    let spec = WORKER_TOOL_SPECS["mcp__orchestrator__list_active_workers"]!
    return ToolDescriptor(
        label: { t in (spec.verb, workerListCount(t).map { "workers (\($0))" } ?? "workers") },
        runningLabel: { _ in (spec.running, "workers") },
        expandable: { workerExpandable($0) },
        detail: { AnyView(WorkerToolBodyView(tool: $0)) })
}

private func listPendingPermissionsDescriptor() -> ToolDescriptor {
    let spec = WORKER_TOOL_SPECS["mcp__orchestrator__list_pending_permissions"]!
    return ToolDescriptor(
        label: { _ in (spec.verb, "pending permissions") },
        runningLabel: { _ in (spec.running, "pending permissions") },
        expandable: { workerExpandable($0) },
        detail: { AnyView(WorkerToolBodyView(tool: $0)) })
}

// A worker tool expands only when it has a non-empty body (the rows/summary text) — mirrors the Mac's
// workerExpandable gate so a still-running call with no result is non-expandable.
private func workerExpandable(_ tool: Tool) -> Bool {
    if tool.result?.isError == true { return !(tool.result?.text.isEmpty ?? true) }
    if let rows = (tool.name == "mcp__orchestrator__list_active_workers" ? listWorkersRows(tool)
                   : tool.name == "mcp__orchestrator__list_pending_permissions" ? pendingRows(tool) : nil) {
        return !rows.isEmpty
    }
    if tool.name == "mcp__orchestrator__spawn_worker", spawnLoopDetails(tool.input["loop"]) != nil { return true }
    return !workerToolDetailText(tool).trimmingCharacters(in: .whitespaces).isEmpty
}

private func createWorkerDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Created worker", t.input["name"]?.stringValue ?? "") },
    runningLabel: { t in ("Creating worker", t.input["name"]?.stringValue ?? "") },
    detail: { AnyView(CreateWorkerDetailView(tool: $0)) }) }

private func availableWorkersDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Listed", workerListCount(t).map { "available workers (\($0))" } ?? "available workers") },
    runningLabel: { _ in ("Listing", "available workers") },
    detail: { AnyView(AvailableWorkersDetailView(tool: $0)) }) }

// MARK: - §2.4 peer descriptors

// The targeted peer (parser-linked peerTo wins; input peerId/peerName fallback).
private func peerAskTarget(_ t: Tool) -> AgentRef? {
    let id = t.peerTo?.id ?? t.input["peerId"]?.stringValue
    let name = t.peerTo?.name ?? t.input["peerName"]?.stringValue ?? t.input["peerId"]?.stringValue
    return (id != nil || name != nil) ? AgentRef(id: id, name: name) : nil
}

private func peerAskDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Asked", peerAskTarget(t)?.name ?? "peer") },
    runningLabel: { t in ("Asking", peerAskTarget(t)?.name ?? "peer") },
    agentRef: { peerAskTarget($0) },
    detail: { AnyView(PeerAskDetailView(tool: $0)) }) }

private func peerRespondDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Replied to", t.peerTo?.name ?? "peer") },
    runningLabel: { t in ("Replying to", t.peerTo?.name ?? "peer") },
    agentRef: { $0.peerTo },
    detail: { AnyView(PeerRespondDetailView(tool: $0)) }) }

private func peerListDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Listed", "peers") }, runningLabel: { _ in ("Listing", "peers") },
    detail: { AnyView(PeerListDetailView(tool: $0)) }) }

private func sendToParentDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Sent report to", "orchestrator") },
    detail: { AnyView(MessageDetailView(tool: $0)) }) }

// MARK: - §2.5 task-management descriptors

private func taskStatusBadge(_ status: String?) -> HeaderBadge? {
    guard let status, !status.isEmpty else { return nil }
    let labels = ["pending": "pending", "in_progress": "in progress", "completed": "completed", "deleted": "deleted"]
    let colors: (Color, Color)
    switch status {
    case "in_progress": colors = (EosColor.coral, EosColor.coral.opacity(0.18))
    case "completed":   colors = (EosColor.State.runningDot, EosColor.State.runningDot.opacity(0.16))
    case "deleted":     colors = (EosColor.State.failedDot, EosColor.State.failedDot.opacity(0.16))
    default:            colors = (EosColor.inkSecondary, EosColor.inkTertiary.opacity(0.20))
    }
    return HeaderBadge(text: labels[status] ?? status, fg: colors.0, bg: colors.1)
}

private func taskCreateDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Created task", t.input["subject"]?.stringValue ?? "") },
    runningLabel: { t in ("Creating task", t.input["subject"]?.stringValue ?? "") },
    headerBadge: { _ in taskStatusBadge("pending") },
    detail: { AnyView(TaskCreateDetailView(tool: $0)) }) }

private func taskUpdateDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Updated task", t.input["taskId"]?.stringValue.map { "#\($0)" } ?? "") },
    runningLabel: { t in ("Updating task", t.input["taskId"]?.stringValue.map { "#\($0)" } ?? "") },
    headerBadge: { taskStatusBadge($0.input["status"]?.stringValue) },
    detail: { AnyView(TaskUpdateDetailView(tool: $0)) }) }

private func taskGetDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Read task", t.input["taskId"]?.stringValue.map { "#\($0)" } ?? "") },
    runningLabel: { t in ("Reading task", t.input["taskId"]?.stringValue.map { "#\($0)" } ?? "") },
    headerBadge: { taskStatusBadge(parseTaskGet($0.result?.text)?.status) },
    detail: { AnyView(TaskGetDetailView(tool: $0)) }) }

private func taskListDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in let n = parseTaskListRows(t.result?.text).count; return ("Listed", n > 0 ? "tasks (\(n))" : "tasks") },
    runningLabel: { _ in ("Listing", "tasks") },
    detail: { AnyView(TaskListDetailView(tool: $0)) }) }

private func todoWriteDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Updated", "task list") }, runningLabel: { _ in ("Updating", "tasks…") },
    summary: { t in
        let todos = t.input["todos"]?.arrayValue ?? []
        guard !todos.isEmpty else { return nil }
        let done = todos.filter { $0["status"]?.stringValue == "completed" }.count
        let active = todos.filter { $0["status"]?.stringValue == "in_progress" }.count
        let pending = todos.filter { $0["status"]?.stringValue == "pending" }.count
        return "\(todos.count) items (\(done) done, \(active) active, \(pending) pending)"
    },
    detail: { AnyView(TodoWriteDetailView(tool: $0)) }) }

// MARK: - §2.6 workflow & misc built-in descriptors

private func workflowDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { workflowLabel($0, running: false) },
    runningLabel: { workflowLabel($0, running: true) },
    headerBadge: { t in workflowStatus(t).flatMap { WorkflowStatusBadge.badge(for: $0) } },
    detail: { AnyView(WorkflowToolDetailView(tool: $0)) }) }

private func datetimeDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { _ in ("Checked", "date & time") }, runningLabel: { _ in ("Checking", "date & time") },
    detail: { AnyView(DatetimeDetailView(tool: $0)) }) }

private func toolSearchDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Searched tools", t.input["query"]?.stringValue ?? "") },
    runningLabel: { t in ("Searching tools", t.input["query"]?.stringValue ?? "") },
    detail: { AnyView(ToolSearchDetailView(tool: $0)) }) }

private func scheduleWakeupDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Scheduled wakeup", formatDelay(t.input["delaySeconds"]?.doubleValue)) },
    runningLabel: { t in ("Scheduling wakeup", formatDelay(t.input["delaySeconds"]?.doubleValue)) },
    detail: { AnyView(ScheduleWakeupDetailView(tool: $0)) }) }

private func taskOutputDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Read task output", t.input["task_id"]?.stringValue ?? "") },
    runningLabel: { t in ("Reading task output", t.input["task_id"]?.stringValue ?? "") },
    detail: { AnyView(TaskOutputDetailView(tool: $0)) }) }

// The workflow status pill as a HeaderBadge (shares WorkflowStatusChip's palette).
enum WorkflowStatusBadge {
    static func badge(for status: String) -> HeaderBadge? {
        let map: [String: (Color, Color)] = [
            "passed": (EosColor.State.runningDot, EosColor.State.runningDot.opacity(0.16)),
            "failed": (EosColor.State.failedDot, EosColor.State.failedDot.opacity(0.18)),
            "running": (EosColor.coral, EosColor.coral.opacity(0.16)),
            "stopped": (EosColor.State.waitingDot, EosColor.State.waitingDot.opacity(0.18)),
            "pending": (EosColor.inkSecondary, EosColor.inkTertiary.opacity(0.20)),
        ]
        guard let c = map[status] else { return nil }
        return HeaderBadge(text: status, fg: c.0, bg: c.1)
    }
}

// MARK: - label helpers (bashLabel / humanizeToolName / argsSummary are pure → kit's ToolViewModel)

func filePathOf(_ tool: Tool) -> String {
    tool.input["file_path"]?.stringValue ?? tool.input["path"]?.stringValue ?? ""
}
private func commandOf(_ tool: Tool) -> String { tool.input["command"]?.stringValue ?? "" }
private func clampCmd(_ cmd: String) -> String { cmd.count > 60 ? String(cmd.prefix(60)) + "…" : cmd }

// Host of a URL for the WebFetch label ("Fetched {host}"), www-stripped; passthrough on parse failure.
private func hostOf(_ url: String?) -> String {
    guard let url, !url.isEmpty else { return "" }
    guard let host = URLComponents(string: url)?.host else { return url }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}
