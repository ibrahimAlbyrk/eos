import Foundation

// A claude pane's transcript as fetched from GET /pty/:id/conversation?afterId=N. Rows arrive in the
// GET /workers/:id/events shape, so `evs` feeds MessageNormalizer.buildBlocks unchanged. Row ids are
// only stable within one Claude Code session: a new claudeSessionId (/clear, /resume) is a new id
// space, so rows cached from the old one are dropped and the page is refetched from afterId=0.
// `pending` is the dialog the pane is blocked on, as of the latest response.
public struct PtyTranscript: Sendable {
    public enum Outcome: Equatable, Sendable { case changed, unchanged, refetch }

    public private(set) var claudeSessionId: String?
    public private(set) var evs: [Ev] = []
    public private(set) var newestId = 0
    public private(set) var running = false
    public private(set) var pending: PendingPrompt?

    public init() {}

    // Fold one response for a request made with `afterId`.
    public mutating func apply(_ body: JSONValue, afterId: Int) -> Outcome {
        let sessionId = body["claudeSessionId"]?.stringValue
        let was = (running, pending)
        running = body["running"]?.boolValue ?? false
        pending = PendingPrompt(pending: body["pending"])
        var changed = running != was.0 || pending != was.1
        if sessionId != claudeSessionId {
            claudeSessionId = sessionId
            evs = []
            newestId = 0
            // Paged past an id this device never saw in the new session — start it over.
            if afterId > 0 { return .refetch }
            changed = true
        }
        let rows = (body["rows"]?.arrayValue ?? [])
            .compactMap { row in row["id"]?.intValue.map { (id: $0, row: row) } }
            .sorted { $0.id < $1.id }
        for (id, row) in rows where id > newestId {
            evs.append(toEv(row))
            newestId = id
            changed = true
        }
        return changed ? .changed : .unchanged
    }
}
