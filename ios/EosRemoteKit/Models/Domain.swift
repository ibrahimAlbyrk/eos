import Foundation

// Thin typed views over the daemon's resource JSON (kept verbatim in `raw`). The fields here
// are the ones the Fleet / detail screens read; anything else stays reachable via `raw[...]`.
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

    public init(raw: JSONValue) { self.raw = raw }
    public static func == (a: Worker, b: Worker) -> Bool { a.raw == b.raw }
}

public struct Pending: Identifiable, Sendable, Equatable {
    public let raw: JSONValue
    public var id: String { raw["id"]?.stringValue ?? "" }
    public var workerId: String? { raw["workerId"]?.stringValue ?? raw["worker_id"]?.stringValue }
    public var tool: String? { raw["tool"]?.stringValue ?? raw["toolName"]?.stringValue }
    public var summary: String? { raw["summary"]?.stringValue ?? raw["input_summary"]?.stringValue }
    public var ttl: Double? { raw["ttl"]?.doubleValue ?? raw["expiresAt"]?.doubleValue }

    public init(raw: JSONValue) { self.raw = raw }
    public static func == (a: Pending, b: Pending) -> Bool { a.raw == b.raw }
}

// One normalized transcript block — the union of both event taxonomies (design §5.2,
// port of messageParser.js normalizeEvents). `kind` drives the ~16 render variants.
public struct Block: Identifiable, Sendable, Equatable {
    public enum Kind: String, Sendable {
        case user, assistant, thinking, tool, toolGroup, agentRun, report, directive
        case peerRequest, loop, terminal, deliveryFailed, cleared, push, pull, worktreePreserved
        case hook, exit, jsonl, unknown
    }
    public let id: String
    public let workerId: String
    public let blockId: String?
    public let kind: Kind
    public let ts: Double
    public let text: String?
    public let raw: JSONValue

    public init(id: String, workerId: String, blockId: String?, kind: Kind, ts: Double, text: String?, raw: JSONValue) {
        self.id = id; self.workerId = workerId; self.blockId = blockId
        self.kind = kind; self.ts = ts; self.text = text; self.raw = raw
    }
}
