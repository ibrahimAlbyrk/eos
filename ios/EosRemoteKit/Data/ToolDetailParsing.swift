import Foundation

// Pure parsing helpers for the Tier-2 tool detail bodies (spec 03 §2.3/§2.5/§2.6/§3, port of the
// non-JSX parts of ToolDetail.jsx / WorkflowCard.jsx / WorkerToolCard.jsx / loopDisplay.js). These are
// UI-agnostic (Tool / JSONValue / String only) so they live in the kit and are unit-tested; the SwiftUI
// detail views consume them. Two families: (a) result-JSON readers for the worker/peer/list tools,
// (b) plain-text parsers for the task tools (whose results are text, not JSON).

// MARK: - result JSON

// A tool's result text parsed as a JSON object/array, or nil while running / on a non-JSON (error)
// result. Mirrors parseResultJson: only `{`/`[`-leading text is attempted.
public func toolResultJSON(_ tool: Tool) -> JSONValue? {
    let text = (tool.result?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.hasPrefix("{") || text.hasPrefix("[") else { return nil }
    guard let data = text.data(using: .utf8),
          let v = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
    return v
}

// One-line clip collapsing whitespace (port of clip(), default 140).
public func clip(_ s: String?, _ n: Int = 140) -> String {
    let t = (s ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    return t.count > n ? String(t.prefix(n - 1)) + "…" : t
}

func joinDot(_ parts: [String?]) -> String { parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }

// MARK: - §2.3 worker-management tool bodies (WorkerToolCard.jsx)

// A worker-tool body row: an AgentLink head ("{name} · {meta}") + an optional `sub` line.
public struct WorkerRow: Sendable, Equatable {
    public let id: String?
    public let name: String?
    public let def: String?
    public let meta: String
    public let sub: String
}

// The acted-on worker for spawn/kill/message/get (port of workerIdentity): input.id/name win, else the
// result snapshot (durable once a killed worker leaves the live list). `name` falls back to the id.
public func workerIdentity(_ tool: Tool) -> AgentRef {
    let res = toolResultJSON(tool)
    let ref: JSONValue? = {
        guard let res, res.arrayValue == nil else { return nil }
        return res["worker"]?.objectValue != nil ? res["worker"] : res
    }()
    let id = tool.input["id"]?.stringValue ?? ref?["id"]?.stringValue
    let name = tool.input["name"]?.stringValue ?? ref?["name"]?.stringValue ?? id
    return AgentRef(id: id, name: name)
}

// Row count for the list tools' header ("workers (3)"), nil while running / non-array result.
public func workerListCount(_ tool: Tool) -> Int? { toolResultJSON(tool)?.arrayValue?.count }

// list_active_workers → AgentLink rows: name (snapshot-preferred) · state + clipped prompt.
public func listWorkersRows(_ tool: Tool) -> [WorkerRow]? {
    guard let arr = toolResultJSON(tool)?.arrayValue else { return nil }
    return arr.map { w in
        WorkerRow(id: w["id"]?.stringValue, name: w["name"]?.stringValue,
                  def: w["worker_definition"]?.stringValue,
                  meta: w["state"]?.stringValue ?? "", sub: clip(w["prompt"]?.stringValue))
    }
}

// list_pending_permissions → rows: worker · tool + input summary.
public func pendingRows(_ tool: Tool) -> [WorkerRow]? {
    guard let arr = toolResultJSON(tool)?.arrayValue else { return nil }
    return arr.map { p in
        WorkerRow(id: p["worker_id"]?.stringValue, name: nil, def: nil,
                  meta: p["tool"]?.stringValue ?? "", sub: pendingInputSummary(p["input"]))
    }
}

private func pendingInputSummary(_ input: JSONValue?) -> String {
    guard let input else { return "" }
    if let s = input.stringValue { return clip(s) }
    for key in ["command", "file_path", "path", "pattern", "url"] {
        if let s = input[key]?.stringValue, !s.isEmpty { return clip(s) }
    }
    if let obj = input.objectValue, !obj.isEmpty { return clip(prettyValueJSON(input)) }
    return ""
}

// kill_worker → "{state} · {branch}".
public func killWorkerDetail(_ tool: Tool) -> String {
    guard let res = toolResultJSON(tool), res.arrayValue == nil else { return "" }
    return joinDot([res["state"]?.stringValue, res["branch"]?.stringValue])
}

// get_worker → "{state} · {branch}" / "${cost} · N events" / clipped prompt (newline-joined).
public func getWorkerDetail(_ tool: Tool) -> String {
    guard let res = toolResultJSON(tool), res.arrayValue == nil, let w = res["worker"], w.objectValue != nil
    else { return "" }
    let cost = w["cost_usd"]?.doubleValue.map { "$" + String(format: "%.4f", $0) }
    let events = res["events"]?.arrayValue.map { "\($0.count) events" }
    let meta = joinDot([cost, events])
    return [joinDot([w["state"]?.stringValue, w["branch"]?.stringValue]), meta, clip(w["prompt"]?.stringValue)]
        .filter { !$0.isEmpty }.joined(separator: "\n")
}

// The plain-text body for spawn/message/kill/get (error text on failure, else the readable summary).
public func workerToolDetailText(_ tool: Tool) -> String {
    if tool.result?.isError == true { return tool.result?.text ?? "" }
    switch tool.name {
    case "mcp__orchestrator__spawn_worker": return tool.input["prompt"]?.stringValue ?? ""
    case "mcp__orchestrator__message_worker": return tool.input["text"]?.stringValue ?? ""
    case "mcp__orchestrator__kill_worker": return killWorkerDetail(tool)
    case "mcp__orchestrator__get_worker": return getWorkerDetail(tool)
    default: return ""
    }
}

// The static arm-at-spawn loop args (spawn_worker only), "Loop: {goal} · {strategy} · limit N" (port of
// spawnLoopDetails). nil when the spawn carried no loop.
public func spawnLoopDetails(_ loop: JSONValue?) -> String? {
    guard let loop, loop.objectValue != nil else { return nil }
    let limitVal = loop["limit"].flatMap { v -> JSONValue? in if case .null = v { return nil }; return v }
    let limit = limitVal.map { "limit \(scalarString($0))" } ?? "unbounded"
    let parts = [loop["goal"]?["summary"]?.stringValue, loop["strategy"]?.stringValue ?? "hybrid", limit]
    return "Loop: " + parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
}

private func scalarString(_ v: JSONValue) -> String {
    if let n = v.doubleValue { return n == n.rounded() ? String(Int(n)) : String(n) }
    return v.stringValue ?? ""
}

// MARK: - §2.5 task-tool plain-text parsers (ToolDetail.jsx)

public struct ParsedTask: Sendable, Equatable {
    public let id: String
    public let subject: String
    public let status: String?
    public let description: String?
    public let blocks: String?
    public let blockedBy: String?
}

// "Task #2: subject / Status: … / Description: … / Blocks: #3 / Blocked by: #1" → fields (port of
// parseTaskGet). nil when the first line isn't a "Task #n:" head.
public func parseTaskGet(_ text: String?) -> ParsedTask? {
    let lines = (text ?? "").components(separatedBy: "\n")
    guard let head = lines.first,
          let m = firstMatch2("^Task #(\\d+):\\s*(.*)$", head) else { return nil }
    var status: String?, desc: String?, blocks: String?, blockedBy: String?
    for line in lines.dropFirst() {
        if let v = firstMatch("^Status:\\s*(.*)$", line, 1) { status = v.trimmingCharacters(in: .whitespaces) }
        else if let v = firstMatch("^Description:\\s*(.*)$", line, 1) { desc = v.trimmingCharacters(in: .whitespaces) }
        else if let v = firstMatch("^Blocks:\\s*(.*)$", line, 1) { blocks = v.trimmingCharacters(in: .whitespaces) }
        else if let v = firstMatch("^Blocked by:\\s*(.*)$", line, 1) { blockedBy = v.trimmingCharacters(in: .whitespaces) }
    }
    return ParsedTask(id: m.0, subject: m.1, status: status, description: desc, blocks: blocks, blockedBy: blockedBy)
}

public struct TaskListRow: Sendable, Equatable, Identifiable {
    public let id: String
    public let status: String
    public let subject: String
    public let owner: String?
    public let blockedBy: String?
}

// "#1 [pending] subject (owner) [blocked by #2]" per line → rows (port of parseTaskListRows). The
// trailing "[blocked by …]" and "(owner)" are peeled off so the subject stays intact.
public func parseTaskListRows(_ text: String?) -> [TaskListRow] {
    (text ?? "").components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
        .compactMap { line -> TaskListRow? in
            guard let m = firstMatch3("^#(\\d+)\\s+\\[([^\\]]+)\\]\\s+(.*)$", line) else { return nil }
            var rest = m.2
            var blockedBy: String?
            if let bb = trailingGroup("\\s*\\[blocked by ([^\\]]+)\\]\\s*$", &rest) { blockedBy = bb }
            var owner: String?
            if let ow = trailingGroup("\\s*\\(([^)]+)\\)\\s*$", &rest) { owner = ow }
            return TaskListRow(id: m.0, status: m.1.trimmingCharacters(in: .whitespaces), subject: rest,
                               owner: owner, blockedBy: blockedBy)
        }
}

// MARK: - §2.6 ToolSearch / ScheduleWakeup / delay

// Tool names from a ToolSearch result — the first "name":"…" in each <function> block (port of
// parseToolSearchNames). Deduped, in order.
public func parseToolSearchNames(_ text: String?) -> [String] {
    guard let text, !text.isEmpty else { return [] }
    var names: [String] = []
    for block in text.components(separatedBy: "<function>") {
        if let name = firstMatch("\"name\"\\s*:\\s*\"([^\"]+)\"", block, 1), !names.contains(name) {
            names.append(name)
        }
    }
    return names
}

// A human "in 45m" delay from a raw seconds count (port of formatDelay). Empty for missing/invalid.
public func formatDelay(_ sec: Double?) -> String {
    guard let sec, sec.isFinite, sec > 0 else { return "" }
    let s = Int(sec.rounded())
    if s < 60 { return "\(s)s" }
    if s < 3600 { let m = s / 60, rem = s % 60; return rem > 0 ? "\(m)m \(rem)s" : "\(m)m" }
    let h = s / 3600, m = (s % 3600) / 60
    return m > 0 ? "\(h)h \(m)m" : "\(h)h"
}

// MARK: - §3 workflow (WorkflowCard.jsx)

// Pretty-print a value: a JSON object/array indented 2 spaces; a string that IS JSON reparsed; else
// passthrough (port of prettyValue). The core "read cleanly, not a raw dump" transform.
public func prettyValueJSON(_ value: JSONValue?) -> String {
    guard let value else { return "" }
    switch value {
    case .null: return ""
    case .string(let s):
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "" }
        if let data = t.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: data) {
            return prettyEncode(v) ?? t
        }
        return t
    default:
        return prettyEncode(value) ?? ""
    }
}

private func prettyEncode(_ v: JSONValue) -> String? {
    let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? e.encode(v), let s = String(data: data, encoding: .utf8) else { return nil }
    return s
}

public struct WorkflowCompletion: Sendable, Equatable {
    public let runId: String?
    public let status: String?
    public let body: String
}

// "[workflow <id>] completed (status: <s>):\n<result>" → { runId, status, body } (port of
// parseCompletion). Falls back to the whole text as the body when the head is absent.
public func parseWorkflowCompletion(_ text: String?, runIdFallback: String? = nil) -> WorkflowCompletion {
    let t = text ?? ""
    let re = try! NSRegularExpression(pattern: "^\\[workflow (.+?)\\]\\s+completed\\s+\\(status:\\s*(\\w+)\\)\\s*:?\\s*\\n?",
                                      options: [.caseInsensitive])
    let ns = t as NSString
    if let m = re.firstMatch(in: t, range: NSRange(location: 0, length: ns.length)) {
        return WorkflowCompletion(runId: ns.substring(with: m.range(at: 1)),
                                  status: ns.substring(with: m.range(at: 2)),
                                  body: ns.substring(from: m.range.length))
    }
    return WorkflowCompletion(runId: runIdFallback, status: nil, body: t)
}

// The name after the workflow header verb: definition for create/run-stored, else the run id.
public func workflowName(_ tool: Tool) -> String {
    let res = toolResultJSON(tool)
    let i = tool.input
    switch i["mode"]?.stringValue {
    case "create": return res?["name"]?.stringValue ?? i["spec"]?["name"]?.stringValue ?? ""
    case "run-stored": return i["from"]?.stringValue ?? res?["runId"]?.stringValue ?? ""
    case "run-inline": return i["spec"]?["name"]?.stringValue ?? res?["runId"]?.stringValue ?? ""
    default: return i["runId"]?.stringValue ?? res?["runId"]?.stringValue ?? ""
    }
}

private let WORKFLOW_MODE_VERB: [String: (done: String, running: String)] = [
    "run-stored": ("Ran workflow", "Running workflow"),
    "run-inline": ("Ran workflow", "Running workflow"),
    "create": ("Saved workflow", "Saving workflow"),
    "status": ("Checked workflow", "Checking workflow"),
    "stop": ("Stopped workflow", "Stopping workflow"),
]

public func workflowLabel(_ tool: Tool, running: Bool) -> (verb: String, file: String) {
    let mode = tool.input["mode"]?.stringValue ?? ""
    let verb = running ? (WORKFLOW_MODE_VERB[mode]?.running ?? "Using workflow")
                       : (WORKFLOW_MODE_VERB[mode]?.done ?? "Used workflow")
    return (verb, running ? "" : workflowName(tool))
}

public func workflowStatus(_ tool: Tool) -> String? { toolResultJSON(tool)?["status"]?.stringValue }

// MARK: - regex helpers (single/triple capture groups over a whole line)

private func firstMatch(_ pattern: String, _ s: String, _ group: Int = 0) -> String? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = s as NSString
    guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)),
          m.range(at: group).location != NSNotFound else { return nil }
    return ns.substring(with: m.range(at: group))
}

// Two capture groups (the Task #n head): (id, subject).
private func firstMatch2(_ pattern: String, _ s: String) -> (String, String)? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = s as NSString
    guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)), m.numberOfRanges >= 3
    else { return nil }
    return (ns.substring(with: m.range(at: 1)), ns.substring(with: m.range(at: 2)))
}

private func firstMatch3(_ pattern: String, _ s: String) -> (String, String, String)? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = s as NSString
    guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)), m.numberOfRanges >= 4
    else { return nil }
    return (ns.substring(with: m.range(at: 1)), ns.substring(with: m.range(at: 2)), ns.substring(with: m.range(at: 3)))
}

// Peel a trailing "(…)"/"[…]" group off the tail, mutating `rest` to the head; returns the captured group.
private func trailingGroup(_ pattern: String, _ rest: inout String) -> String? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = rest as NSString
    guard let m = re.firstMatch(in: rest, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let group = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
    rest = ns.substring(to: m.range.location).trimmingCharacters(in: .whitespaces)
    return group
}
