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

// The transcript `Block` model lives in Block.swift (spec 03 §4.2 — the typed-payload rewrite).
