import Foundation

// Single source of truth for "is this tool still running?" (spec 03 §4.6, port of toolLifecycle.js).
//
// A tool's terminal signal is its jsonl tool_result or a tool_done hook. Both ride best-effort
// channels, so a tool with neither must NOT shimmer forever: a turn-end barrier (Stop hook,
// IDLE/DONE state, interrupt, delivery_failed) closes every plain tool that started before it, and a
// worker exit closes everything — including background-agent inner tools, which legitimately outlive
// turns and are therefore exempt from turn barriers.

// A normalized event row as buildBlocks sees it: { type, ts, payload }. payload is a JSON string on
// durable rows, an object on live frames — accept either (mirrors JS parsePayload).
public struct Ev: Sendable {
    public let type: String
    public let ts: Double
    public let payload: JSONValue
    public init(type: String, ts: Double, payload: JSONValue) {
        self.type = type; self.ts = ts; self.payload = payload
    }
}

// Rows carry `payload` as a JSON string (DB column) or an already-decoded object (live). Return an
// object either way; an empty object stands in for null (JS parsePayload returns {}).
func parsePayload(_ v: JSONValue?) -> JSONValue {
    guard let v else { return .object([:]) }
    if case .string(let s) = v { return JSONValue.parse(s) ?? .object([:]) }
    return v
}

public struct ToolLifecycle {
    private let jsonlResults: [String: ToolResult]
    private let doneResults: [String: ToolResult]
    private let done: Set<String>
    private let turnBarrier: Int
    private let exitBarrier: Int

    init(jsonlResults: [String: ToolResult], doneResults: [String: ToolResult],
         done: Set<String>, turnBarrier: Int, exitBarrier: Int) {
        self.jsonlResults = jsonlResults; self.doneResults = doneResults
        self.done = done; self.turnBarrier = turnBarrier; self.exitBarrier = exitBarrier
    }

    // jsonl tool_result wins over the hook-delivered copy (richer, exact text).
    public func resultOf(_ id: String) -> ToolResult? { jsonlResults[id] ?? doneResults[id] }
    public func isDone(_ id: String) -> Bool { done.contains(id) }
    public func exitAfter(_ idx: Int) -> Bool { exitBarrier > idx }

    // A tool first seen at event index `idx` is closed when it has a terminal signal or a barrier
    // landed after it. `turnExempt` skips the turn barrier (background-agent inner tools).
    public func isClosed(_ id: String, _ idx: Int, turnExempt: Bool = false) -> Bool {
        if jsonlResults[id] != nil || done.contains(id) { return true }
        if exitBarrier > idx { return true }
        if !turnExempt && turnBarrier > idx { return true }
        return false
    }
}

public func deriveToolLifecycle(_ events: [Ev]) -> ToolLifecycle {
    var jsonlResults: [String: ToolResult] = [:]
    var doneResults: [String: ToolResult] = [:]
    var done: Set<String> = []
    var turnBarrier = -1
    var exitBarrier = -1

    for (i, ev) in events.enumerated() {
        if ev.type == "jsonl" {
            let p = parsePayload(ev.payload)
            if p["kind"]?.stringValue == "tool_result", let id = p["toolUseId"]?.stringValue {
                jsonlResults[id] = ToolResult(text: p["text"]?.stringValue ?? "",
                                              isError: p["isError"]?.boolValue == true,
                                              patch: p["patch"].flatMap { $0 == .null ? nil : $0 })
            }
            continue
        }
        if ev.type == "tool_done" {
            let p = parsePayload(ev.payload)
            if let id = p["toolUseId"]?.stringValue {
                done.insert(id)
                let result = p["result"]?.stringValue ?? ""
                if result != "" {
                    doneResults[id] = ToolResult(text: result, isError: p["isError"]?.boolValue == true)
                }
            }
            continue
        }
        if isTurnBarrier(ev) { turnBarrier = i }
        if isExitBarrier(ev) { exitBarrier = i }
    }

    return ToolLifecycle(jsonlResults: jsonlResults, doneResults: doneResults,
                         done: done, turnBarrier: turnBarrier, exitBarrier: exitBarrier)
}

private func isTurnBarrier(_ ev: Ev) -> Bool {
    switch ev.type {
    case "hook":
        let e = parsePayload(ev.payload)["event"]?.stringValue
        return e == "Stop" || e == "SessionEnd"
    case "state":
        let s = parsePayload(ev.payload)["state"]?.stringValue
        return s == "IDLE" || s == "ENDING" || s == "DONE"
    case "lifecycle":
        let ph = parsePayload(ev.payload)["phase"]?.stringValue
        return ph == "interrupted" || ph == "delivery_failed"
    default:
        return false
    }
}

private func isExitBarrier(_ ev: Ev) -> Bool {
    if ev.type == "exit" { return true }
    if ev.type == "lifecycle" { return parsePayload(ev.payload)["phase"]?.stringValue == "pty_exit" }
    return false
}

// Typed provider-error codes → human English with remediation (spec 03 §4.6). Keys match the STRING
// contract from the in-process model clients; any other reason falls back to the raw string.
private let providerErrorMessages: [String: String] = [
    "insufficient_credits": "Provider API credits exhausted — add credits in your provider console.",
    "auth_invalid": "Provider API key invalid or expired — check the key in your provider settings.",
]

public func providerErrorMessage(_ reason: String?) -> String {
    if let reason, let m = providerErrorMessages[reason] { return m }
    if let reason, !reason.isEmpty { return reason }
    return "The model turn failed."
}

public enum FailureKind: String, Sendable { case denied, failed }

// failureKind(tool): isError → denied (permission-flavoured message) else failed (spec 03 §4.6).
public func failureKind(_ tool: Tool) -> FailureKind? {
    guard tool.result?.isError == true else { return nil }
    let text = tool.result?.text ?? ""
    let range = text.range(of: "denied|permission mode|denied by policy", options: [.regularExpression, .caseInsensitive])
    return range != nil ? .denied : .failed
}
