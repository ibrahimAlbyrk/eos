import Foundation

// Verb/label specs for the orchestrator's worker-management MCP tools (port of workerTools.js) —
// the source of truth shared by the parser (lane grouping + group summaries) and the Phase-4b
// WorkerToolCard. Result-JSON detail rendering stays in the renderer.
public struct WorkerToolSpec: Sendable {
    public let verb: String
    public let running: String
    public let summary: @Sendable (Int) -> String
}

private func plural(_ n: Int) -> String { "\(n) worker\(n > 1 ? "s" : "")" }
private func times(_ n: Int) -> String { n > 1 ? " ×\(n)" : "" }

public let WORKER_TOOL_SPECS: [String: WorkerToolSpec] = [
    "mcp__orchestrator__spawn_worker": WorkerToolSpec(verb: "Spawned", running: "Spawning", summary: { "Spawned \(plural($0))" }),
    "mcp__orchestrator__kill_worker": WorkerToolSpec(verb: "Killed", running: "Killing", summary: { "Killed \(plural($0))" }),
    "mcp__orchestrator__message_worker": WorkerToolSpec(verb: "Messaged", running: "Messaging", summary: { "Messaged \(plural($0))" }),
    "mcp__orchestrator__get_worker": WorkerToolSpec(verb: "Checked", running: "Checking", summary: { "Checked \(plural($0))" }),
    "mcp__orchestrator__list_active_workers": WorkerToolSpec(verb: "Listed", running: "Listing", summary: { "Listed workers\(times($0))" }),
    "mcp__orchestrator__list_pending_permissions": WorkerToolSpec(verb: "Checked", running: "Checking", summary: { "Checked pending permissions\(times($0))" }),
]

public func isWorkerToolName(_ name: String) -> Bool { WORKER_TOOL_SPECS[name] != nil }
