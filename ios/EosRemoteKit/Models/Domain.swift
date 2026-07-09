import Foundation

// Thin typed views over the daemon's resource JSON (kept verbatim in `raw`). The fields here
// are the ones the Code list / detail screens read; anything else stays reachable via `raw[...]`.
public struct Worker: Identifiable, Sendable, Equatable {
    public let raw: JSONValue
    public var id: String { raw["id"]?.stringValue ?? "" }
    public var name: String { raw["name"]?.stringValue ?? id }
    public var isOrchestrator: Bool { raw["is_orchestrator"]?.boolValue ?? false }
    public var state: String { raw["state"]?.stringValue ?? "UNKNOWN" }
    public var model: String? { raw["model"]?.stringValue }
    public var effort: String? { raw["effort"]?.stringValue }
    public var tokens: Int? { raw["tokens"]?.intValue ?? raw["total_tokens"]?.intValue }
    public var costUSD: Double? { raw["cost"]?.doubleValue ?? raw["cost_usd"]?.doubleValue }
    // Backend lane (claude-cli / claude-sdk / metered). Drives capability gates (rewind, §5.2).
    public var backendKind: String { raw["backend_kind"]?.stringValue ?? raw["backendKind"]?.stringValue ?? "claude-cli" }

    // The spawning orchestrator's id + this worker's boot prompt (WorkerRowSchema.parent_id/prompt).
    // Together they gate the top-of-transcript TaskFromView (spec 03 §1 MessageTask).
    public var parentId: String? { raw["parent_id"]?.stringValue ?? raw["parentId"]?.stringValue }
    public var prompt: String? { raw["prompt"]?.stringValue }

    // Active dynamic-loop status (WorkerRowSchema.loop, HTTP-enriched). Drives the top-of-transcript
    // LoopStatusCardView (spec 03 §1 LoopStatus). Absent when the worker has no active loop.
    public var loop: WorkerLoop? { WorkerLoop(raw: raw["loop"]) }

    // Redesign data surface (REDESIGN_CONTRACT §H P2) — typed views over the WorkerRow columns the
    // Code list / conversation screens read. All optional-safe over `raw`.
    public var startedAt: Double { raw["started_at"]?.doubleValue ?? 0 }
    public var turnStartedAt: Double? { raw["turn_started_at"]?.doubleValue }
    public var endedAt: Double? { raw["ended_at"]?.doubleValue }
    public var archivedAt: Double? { raw["archived_at"]?.doubleValue }
    public var cwd: String? { raw["cwd"]?.stringValue }
    public var permissionMode: String? { raw["permission_mode"]?.stringValue }
    public var tokensIn: Int? { raw["tokens_in"]?.intValue }
    public var tokensOut: Int? { raw["tokens_out"]?.intValue }
    public var toolCalls: Int? { raw["tool_calls"]?.intValue }
    public var workerDefinition: String? { raw["worker_definition"]?.stringValue }
    public var agentRole: String? { raw["agent_role"]?.stringValue }
    // D-5: a worker's "last active" instant — turn clock when it ever ran a turn, else spawn time.
    public var recencyKey: Double { max(turnStartedAt ?? 0, startedAt) }

    public init(raw: JSONValue) { self.raw = raw }
    public static func == (a: Worker, b: Worker) -> Bool { a.raw == b.raw }
}

// A worker's active dynamic-loop state (contracts WorkerRowSchema.loop). `maxAttempts` is nil for an
// unbounded loop; `status` is active | passed | exhausted | stopped.
public struct WorkerLoop: Sendable, Equatable {
    public let status: String
    public let attempt: Int
    public let maxAttempts: Int?
    public let lastReason: String?
    public let goalSummary: String?

    public init?(raw: JSONValue?) {
        guard let raw, case .object = raw, let status = raw["status"]?.stringValue else { return nil }
        self.status = status
        self.attempt = raw["attempt"]?.intValue ?? 0
        self.maxAttempts = raw["maxAttempts"]?.intValue
        self.lastReason = raw["lastReason"]?.stringValue
        self.goalSummary = raw["goalSummary"]?.stringValue
    }

    // "N/M" when bounded, "N" when unbounded (port of loopAttemptText).
    public var attemptText: String { maxAttempts.map { "\(attempt)/\($0)" } ?? String(attempt) }
}

// Capabilities the UI gates controls on (spec 03 §5.2, port of backendCaps.js). Only the fields this
// phase needs: rewind (message rewind is a PTY-only affordance). claude-cli drives Claude's native TUI
// rewind via keystrokes → true; the SDK lane and metered providers have no keystroke channel → false.
public struct BackendCaps: Sendable {
    public let rewind: Bool
    public static func of(_ kind: String) -> BackendCaps {
        switch kind {
        case "claude-cli": return BackendCaps(rewind: true)
        default:           return BackendCaps(rewind: false)   // claude-sdk, anthropic-api, openai, codex
        }
    }
}

public struct Pending: Identifiable, Sendable, Equatable {
    public let raw: JSONValue
    public var id: String { raw["id"]?.stringValue ?? "" }
    public var workerId: String? { raw["workerId"]?.stringValue ?? raw["worker_id"]?.stringValue }
    public var tool: String? { raw["tool"]?.stringValue ?? raw["toolName"]?.stringValue }
    public var summary: String? { raw["summary"]?.stringValue ?? raw["input_summary"]?.stringValue }
    public var ttl: Double? { raw["ttl"]?.doubleValue ?? raw["expiresAt"]?.doubleValue }

    // Redesign data surface (§H P2). `toolName` prefers the wire column (PendingPermissionRow.
    // tool_name) and falls back to the legacy keys `tool` already reads; `inputRaw` is the
    // permission input verbatim — a JSON STRING the banner parses for command/file_path/….
    public var toolName: String? { raw["tool_name"]?.stringValue ?? tool }
    public var inputRaw: String? { raw["input"]?.stringValue }

    public init(raw: JSONValue) { self.raw = raw }
    public static func == (a: Pending, b: Pending) -> Bool { a.raw == b.raw }
}

// The transcript `Block` model lives in Block.swift (spec 03 §4.2 — the typed-payload rewrite).
