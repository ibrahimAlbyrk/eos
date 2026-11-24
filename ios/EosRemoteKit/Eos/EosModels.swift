import Foundation

// What the Eos tab reads from a Mac that serves routines (cap `eos`, 07 §4.5, §4.8): the rows of
// `GET /api/routines`, `GET /api/runs/:id` and `GET /api/inbox`, as the Mac writes them. Unknown
// fields are ignored, so a newer Mac still reads here.

public struct EosRunSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let routineId: String
    /// `queued`, `running`, `checking`, `waiting_for_user`, `delivering`, `done`, `skipped`,
    /// `cancelled`, `paused` or `failed`.
    public let state: String
    public let station: String?
    public let reason: String?
    public let headline: String?
    public let itemTitle: String?
    public let needsUser: Bool
    public let costUsd: Double
    public let workMs: Int
    public let createdAt: Double
    public let startedAt: Double?
    public let endedAt: Double?

    public var ended: Bool { ["done", "skipped", "cancelled", "failed"].contains(state) }
}

public struct EosTakes: Codable, Sendable, Equatable {
    public let kind: String
    public let label: String
    public let placeholder: String
    public let many: Bool
}

public struct EosRoutineOption: Codable, Sendable, Equatable {
    public let key: String
    public let label: String
    /// `choice`, `bool`, `text` or `number`.
    public let type: String
    public let values: [String]?
    public let `default`: JSONValue
    public let inline: Bool
}

public struct EosUsual: Codable, Sendable, Equatable {
    public let usd: Double
    public let ms: Int
}

public struct EosRoutine: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let slug: String
    public let name: String
    public let summary: String
    public let icon: String
    /// `standing`, `project`, `once`, `transient`.
    public let kind: String
    /// `active`, `paused`, `draft`, …
    public let state: String
    public let triggerLine: String?
    public let takes: EosTakes
    public let options: [EosRoutineOption]
    public let usual: EosUsual?
    public let activeRuns: Int
    public let lastRun: EosRunSummary?
}

public struct EosRunAgent: Codable, Sendable, Equatable, Identifiable {
    public let workerId: String
    public let name: String?
    /// `solo`, `lead`, `script`, `specialist` or `checker`.
    public let role: String
    public let state: String
    public let costUsd: Double
    public let lastActivity: String?
    public var id: String { workerId }
}

public struct EosRunDetail: Codable, Sendable, Equatable {
    public let run: EosRunSummary
    public let attempt: Int
    public let agents: [EosRunAgent]
    public let usual: EosUsual?
}

/// One line of a run's team (`run:activity`), as the phone shows it live.
public struct EosRunActivity: Codable, Sendable, Equatable {
    public let runId: String
    public let workerId: String
    public let line: String
    public let at: Double
}

public struct EosInboxItem: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    /// `open`, `later`, `answered`, `replaced`, `expired` or `withdrawn`.
    public let state: String
    public let routineId: String?
    public let runId: String?
    public let title: String
    public let summary: String
    /// An answer or a saved edit names the rev it was made on.
    public let rev: Int
    public let staleAt: Double?
    public let createdAt: Double
    public let updatedAt: Double
}

public struct EosInboxCounts: Codable, Sendable, Equatable {
    public let open: Int
    public let later: Int
}

public struct EosInboxList: Codable, Sendable, Equatable {
    public let items: [EosInboxItem]
    public let counts: EosInboxCounts
}

/// An item to run on (01's `ItemRef`): what the user typed or shared, or a candidate the Mac named.
public struct EosItem: Codable, Sendable, Equatable, Hashable {
    public var kind: String
    public var key: String?
    public var title: String?
    public var url: String?
    public var text: String?
    /// It came from outside the user's own text: a link's page, a shared item. Required.
    public var untrusted: Bool

    public init(kind: String, key: String? = nil, title: String? = nil, url: String? = nil, text: String? = nil,
                untrusted: Bool) {
        self.kind = kind; self.key = key; self.title = title; self.url = url; self.text = text
        self.untrusted = untrusted
    }

    /// What the user typed: a link when it is one, else their own text.
    public static func typed(_ raw: String) -> EosItem? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
           url.host != nil {
            return EosItem(kind: "link", url: text, untrusted: true)
        }
        return EosItem(kind: "text", text: text, untrusted: false)
    }
}
