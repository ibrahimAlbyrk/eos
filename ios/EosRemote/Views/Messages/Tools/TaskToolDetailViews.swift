import SwiftUI
import EosRemoteKit

// Task-management tool detail bodies (spec 03 §2.5, port of the TaskCreate/Update/Get/List/TodoWrite
// entries in ToolDetail.jsx). These harness built-ins return PLAIN TEXT (not JSON): the collapsed row
// carries the subject/#id/count from input, and the Get/List bodies parse the result text
// (parseTaskGet / parseTaskListRows). All bodies reuse the .wd-card / task-badge chrome.

// TaskCreate — subject heading + pending badge + description (input is the artifact; renders while running).
struct TaskCreateDetailView: View {
    let tool: Tool
    private var subject: String? { tool.input["subject"]?.stringValue }
    private var description: String? { tool.input["description"]?.stringValue }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if subject != nil || description != nil {
            WdCard {
                taskHead(subject ?? "", badge: "pending")
                if let description, !description.isEmpty { WdText(text: description) }
            }
        }
    }
}

// TaskUpdate — "Task #{id}" + new-status badge + changed description + subject/owner chips + added
// blocks/blockedBy dep pills (only the fields this call changed).
struct TaskUpdateDetailView: View {
    let tool: Tool
    private var input: JSONValue { tool.input }
    private var taskId: String { input["taskId"]?.stringValue ?? "" }
    private var status: String? { input["status"]?.stringValue }
    private var description: String? { input["description"]?.stringValue }
    private var chips: [(String, String)] {
        [("subject", input["subject"]?.stringValue), ("owner", input["owner"]?.stringValue)]
            .compactMap { k, v in v.map { (k, $0) } }
    }
    private var blocks: [String] { (input["addBlocks"]?.arrayValue ?? []).map { "#" + ($0.stringValue ?? scalar($0)) } }
    private var blockedBy: [String] { (input["addBlockedBy"]?.arrayValue ?? []).map { "#" + ($0.stringValue ?? scalar($0)) } }
    private var hasAny: Bool { status != nil || description != nil || !chips.isEmpty || !blocks.isEmpty || !blockedBy.isEmpty }

    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if hasAny {
            WdCard {
                taskHead("Task #\(taskId)", badge: status)
                if let description, !description.isEmpty { WdText(text: description) }
                if !chips.isEmpty {
                    WrapRow(items: chips.map { ChipItem(key: $0.0, value: $0.1) }) { WdChip(keyLabel: $0.key, value: $0.value) }
                }
                if !blocks.isEmpty || !blockedBy.isEmpty { TaskDepsView(blocks: joined(blocks), blockedBy: joined(blockedBy)) }
            }
        }
    }
    private struct ChipItem: Hashable { let key: String; let value: String }
    private func joined(_ ids: [String]) -> String? { ids.isEmpty ? nil : ids.joined(separator: ", ") }
    private func scalar(_ v: JSONValue) -> String { v.intValue.map(String.init) ?? "" }
}

// TaskGet — subject + status badge + description + dep pills (parsed from the plain-text result).
struct TaskGetDetailView: View {
    let tool: Tool
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if let task = parseTaskGet(tool.result?.text) {
            WdCard {
                taskHead(task.subject, badge: task.status)
                if let d = task.description, !d.isEmpty { WdText(text: d) }
                if task.blocks != nil || task.blockedBy != nil { TaskDepsView(blocks: task.blocks, blockedBy: task.blockedBy) }
            }
        }
    }
}

// TaskList — one row per task: #id + status badge + subject + owner + blocked-by pill (parsed per line).
struct TaskListDetailView: View {
    let tool: Tool
    private var text: String { (tool.result?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if !text.isEmpty {
            let rows = parseTaskListRows(text)
            WdCard {
                if rows.isEmpty {
                    Text(text).font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { r in taskRow(r) }
                    }
                }
            }
        }
    }
    private func taskRow(_ r: TaskListRow) -> some View {
        HStack(spacing: 8) {
            Text("#\(r.id)").font(EosFont.codeSmall).foregroundStyle(EosColor.inkTertiary)   // .task-row-id (§10)
            TaskBadge(status: r.status)
            Text(r.subject).font(EosFont.caption).foregroundStyle(EosColor.ink)              // .task-row-subject (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let owner = r.owner { Text(owner).font(EosFont.codeSmall).foregroundStyle(EosColor.inkSecondary) }
            if let bb = r.blockedBy { TaskDepPill(text: "blocked by \(bb)", blocked: true) }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .top) {
            if r.id != parseTaskListRows(text).first?.id {
                Rectangle().fill(EosColor.hairline).frame(height: 1)   // .task-row + .task-row border-top (§10)
            }
        }
    }
}

// TodoWrite — header count line + one status-badge row per todo (activeForm / content).
struct TodoWriteDetailView: View {
    let tool: Tool
    private var todos: [JSONValue] { tool.input["todos"]?.arrayValue ?? [] }
    private var counts: (done: Int, active: Int, pending: Int) {
        (todos.filter { $0["status"]?.stringValue == "completed" }.count,
         todos.filter { $0["status"]?.stringValue == "in_progress" }.count,
         todos.filter { $0["status"]?.stringValue == "pending" }.count)
    }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if !todos.isEmpty {
            let c = counts
            WdCard {
                Text("\(todos.count) items (\(c.done) completed, \(c.active) in progress, \(c.pending) pending)")
                    .font(EosFont.caption).fontWeight(.semibold).foregroundStyle(EosColor.ink)  // .task-subject (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { idx, todo in todoRow(todo, idx: idx) }
                }
            }
        }
    }
    private func todoRow(_ todo: JSONValue, idx: Int) -> some View {
        HStack(spacing: 8) {
            TaskBadge(status: todo["status"]?.stringValue ?? "pending")
            Text(todo["activeForm"]?.stringValue ?? todo["content"]?.stringValue ?? "")
                .font(EosFont.caption).foregroundStyle(EosColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .overlay(alignment: .top) {
            if idx > 0 { Rectangle().fill(EosColor.hairline).frame(height: 1) }
        }
    }
}

// MARK: - shared task atoms

// .wd-sec.task-head: subject heading + status badge.
@ViewBuilder private func taskHead(_ subject: String, badge: String?) -> some View {
    HStack(spacing: 6) {
        Text(subject).font(EosFont.caption).fontWeight(.semibold).foregroundStyle(EosColor.ink)  // .task-subject 600 (§10)
            .frame(maxWidth: .infinity, alignment: .leading)
        if let badge, !badge.isEmpty { TaskBadge(status: badge) }
    }
}

// .task-deps: the blocks / blocked-by dependency pill row.
private struct TaskDepsView: View {
    let blocks: String?
    let blockedBy: String?
    var body: some View {
        if blocks != nil || blockedBy != nil {
            HStack(spacing: 6) {
                if let blocks { TaskDepPill(text: "blocks \(blocks)") }
                if let blockedBy { TaskDepPill(text: "blocked by \(blockedBy)", blocked: true) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
