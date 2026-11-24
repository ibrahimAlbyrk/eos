import Foundation

// Answers the phone gave while its Mac may be away (07 §4.8): each names the item's revision it was
// given on, waits here (in the App Group container, so the share extension's runs wait here too)
// and goes when the Mac is back, in the order given. The Mac checks the revision as it checks the
// dashboard's: an item that moved on answers 409, and the answer is dropped and shown as changed,
// never sent on a newer state.
public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// The Needs-you item it answers; none for a run started from the share sheet.
    public let itemId: String?
    public let method: String
    public let path: String
    public let body: JSONValue
    public let createdAt: Double

    public init(id: String = UUID().uuidString, itemId: String?, method: String = "POST", path: String,
                body: JSONValue, createdAt: Double = Date().timeIntervalSince1970) {
        self.id = id; self.itemId = itemId; self.method = method; self.path = path; self.body = body
        self.createdAt = createdAt
    }

    /// `POST /api/inbox/:id/send`: the draft as edited here (none: as it is), on revision `rev`.
    public static func send(item: String, rev: Int, doc: ResultDocument?, confirmStale: Bool) -> OutboxEntry {
        var body: [String: JSONValue] = ["rev": .number(Double(rev))]
        if let doc, let encoded = try? JSONValue(encodable: doc) { body["doc"] = encoded }
        if confirmStale { body["confirmStale"] = .bool(true) }
        return OutboxEntry(itemId: item, path: "/api/inbox/\(item)/send", body: .object(body))
    }

    /// `POST /api/inbox/:id/answer`: one of the item kind's choices.
    public static func answer(item: String, rev: Int, kind: String, choice: String) -> OutboxEntry {
        OutboxEntry(itemId: item, path: "/api/inbox/\(item)/answer",
                    body: .object(["rev": .number(Double(rev)),
                                   "answer": .object(["kind": .string(kind), "choice": .string(choice)])]))
    }

    public static func discard(item: String, rev: Int) -> OutboxEntry {
        OutboxEntry(itemId: item, path: "/api/inbox/\(item)/discard", body: .object(["rev": .number(Double(rev))]))
    }

    public static func later(item: String) -> OutboxEntry {
        OutboxEntry(itemId: item, path: "/api/inbox/\(item)/later", body: .object([:]))
    }

    /// `POST /api/runs`: a run started while the Mac was away.
    public static func start(_ body: JSONValue) -> OutboxEntry {
        OutboxEntry(itemId: nil, path: "/api/runs", body: body)
    }
}

/// What became of an entry the Mac was asked.
public enum OutboxResult: Equatable, Sendable {
    case sent
    /// The item moved on (409): the Mac's words, and nothing was done.
    case changed(String)
    /// Its subject moved on since the draft was made: sending needs a second yes.
    case stale(String)
    /// Refused for another reason.
    case refused(String)
}

/// One answer of the Mac: its status and body; nil when the Mac could not be asked.
public typealias OutboxCall = (_ method: String, _ path: String, _ body: JSONValue) async -> (Int, JSONValue?)?

public final class AnswerOutbox: @unchecked Sendable {
    private let file: URL
    private let lock = NSLock()
    private var flushing = false

    public init(file: URL) {
        self.file = file
    }

    /// One outbox per Mac, beside its cache.
    public static func shared(device: String) -> AnswerOutbox {
        AnswerOutbox(file: EosCache.sharedDir().appendingPathComponent("outbox-\(device).json"))
    }

    public var entries: [OutboxEntry] {
        lock.lock(); defer { lock.unlock() }
        return read()
    }

    public func add(_ entry: OutboxEntry) {
        lock.lock(); defer { lock.unlock() }
        // A newer answer to the same item takes the place of one not sent yet.
        var list = read().filter { entry.itemId == nil || $0.itemId != entry.itemId }
        list.append(entry)
        write(list)
    }

    /// Sends what waits, oldest first, until the Mac cannot be reached; answers what became of each
    /// entry that left the outbox.
    public func flush(isolation: isolated (any Actor)? = #isolation,
                      _ call: OutboxCall) async -> [(OutboxEntry, OutboxResult)] {
        guard begin() else { return [] }
        defer { end() }
        var done: [(OutboxEntry, OutboxResult)] = []
        for entry in entries {
            guard let (status, body) = await call(entry.method, entry.path, entry.body) else { break }
            done.append((entry, Self.result(status: status, body: body)))
            remove(entry.id)
        }
        return done
    }

    public static func result(status: Int, body: JSONValue?) -> OutboxResult {
        if (200..<300).contains(status) { return .sent }
        let error = body?["error"]?.stringValue ?? "refused (\(status))"
        if status == 409 {
            if error == "stale" { return .stale(body?["staleReason"]?.stringValue ?? "Its subject moved on.") }
            return .changed(error == "changed" ? "It changed on your Mac." : error)
        }
        return .refused(error)
    }

    private func begin() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if flushing { return false }
        flushing = true
        return true
    }

    private func end() {
        lock.lock(); flushing = false; lock.unlock()
    }

    private func remove(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        write(read().filter { $0.id != id })
    }

    private func read() -> [OutboxEntry] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([OutboxEntry].self, from: data)) ?? []
    }

    private func write(_ list: [OutboxEntry]) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(list) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
