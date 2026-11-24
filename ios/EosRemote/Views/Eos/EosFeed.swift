import Foundation
import EosRemoteKit

// One paired Mac's routines, runs and Needs you (cap `eos`, 07 §4.5, §4.8). Read through the same
// routes the dashboard calls, so the Mac's access tiers and gate apply to every answer and start;
// kept fresh by the Mac's `routine:change`, `run:change`, `inbox:change` and `runs:active`, and a
// watched run's `run:activity`. What was last read is cached per Mac for when it is away.
@MainActor
final class EosFeed: ObservableObject {
    /// A control and its answer whatever its status; nil when the Mac could not be asked.
    typealias Call = (_ method: String, _ path: String, _ body: JSONValue) async -> ReplyFrame?

    @Published private(set) var serves = false
    @Published private(set) var routines: [EosRoutine] = []
    @Published private(set) var inbox: [EosInboxItem] = []
    /// When the lists were last read from the Mac (unix seconds); 0 never.
    @Published private(set) var seenAt: Double = 0
    @Published private(set) var runs: [String: EosRunDetail] = [:]
    /// The live lines of the watched run, newest last.
    @Published private(set) var activity: [EosRunActivity] = []

    private let deviceId: String
    private let cache: EosCache
    private var call: Call = { _, _, _ in nil }
    private var sendWatch: (String?) -> Void = { _ in }
    private var watched: String?
    /// The most live lines kept for the open run.
    private let activityMax = 200

    init(deviceId: String, cache: EosCache) {
        self.deviceId = deviceId
        self.cache = cache
        if let saved = cache.load(device: deviceId) {
            routines = saved.routines; inbox = saved.inbox; seenAt = saved.seenAt
        }
    }

    /// How it reaches the Mac: a control answered whatever its status, and the `watch` frame.
    func attach(call: @escaping Call, sendWatch: @escaping (String?) -> Void) {
        self.call = call
        self.sendWatch = sendWatch
    }

    /// The Mac's snapshot caps arrived.
    func macCaps(_ caps: Set<String>) {
        let was = serves
        serves = caps.contains("eos")
        if serves && !was { live() }
    }

    /// A new live link: the Mac forgot the watch, and changes may have passed unseen.
    func live() {
        guard serves else { return }
        sendWatch(watched)
        Task { await reloadRoutines(); await reloadInbox() }
    }

    func handle(_ event: EventFrame) {
        if event.reason == "run:activity" {
            guard let payload = event.payload, let data = try? JSONEncoder().encode(payload),
                  let line = try? JSONDecoder().decode(EosRunActivity.self, from: data), line.runId == watched
            else { return }
            activity.append(line)
            if activity.count > activityMax { activity.removeFirst(activity.count - activityMax) }
            return
        }
        for refresh in EosRefresh.of(topic: event.reason, payload: event.payload) {
            switch refresh {
            case .routines: Task { await reloadRoutines() }
            case .inbox: Task { await reloadInbox() }
            case .run(let id) where runs[id] != nil || id == watched: Task { await loadRun(id) }
            case .run, .none: break
            }
        }
    }

    // MARK: reads

    func reloadRoutines() async {
        guard let rows: [EosRoutine] = await read("/api/routines") else { return }
        routines = rows.filter { $0.kind == "standing" || $0.kind == "project" }
        saved()
    }

    func reloadInbox() async {
        guard let list: EosInboxList = await read("/api/inbox") else { return }
        inbox = list.items
        saved()
    }

    @discardableResult
    func loadRun(_ id: String) async -> EosRunDetail? {
        guard let detail: EosRunDetail = await read("/api/runs/\(id)") else { return nil }
        runs[id] = detail
        return detail
    }

    func candidates(_ routineId: String) async -> [EosItem] {
        struct Candidates: Decodable { let items: [EosItem] }
        let found: Candidates? = await read("/api/routines/\(routineId)/candidates")
        return found?.items ?? []
    }

    // MARK: writes

    /// Starts a run; answers its id, or what the Mac said instead.
    func start(_ body: JSONValue) async -> Result<String, EosRefusal> {
        guard let reply = await call("POST", "/api/runs", body) else { return .failure(.unreachable) }
        guard (200..<300).contains(reply.status) else { return .failure(.refused(Self.message(reply))) }
        guard let id = reply.body?["runs"]?.arrayValue?.first?["id"]?.stringValue else {
            return .failure(.refused("The Mac started no run."))
        }
        return .success(id)
    }

    func stop(_ runId: String) async -> EosRefusal? {
        await write("POST", "/api/runs/\(runId)/stop", .object([:]))
    }

    func message(_ runId: String, _ text: String) async -> EosRefusal? {
        await write("POST", "/api/runs/\(runId)/message", EosRequests.message(text))
    }

    /// The run this phone has open; the Mac sends its live lines while it is.
    func watch(_ runId: String?) {
        guard runId != watched else { return }
        watched = runId
        activity = []
        if serves { sendWatch(runId) }
    }

    // MARK: plumbing

    private func read<T: Decodable>(_ path: String) async -> T? {
        guard let reply = await call("GET", path, .object([:])), (200..<300).contains(reply.status),
              let body = reply.body, let data = try? JSONEncoder().encode(body) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func write(_ method: String, _ path: String, _ body: JSONValue) async -> EosRefusal? {
        guard let reply = await call(method, path, body) else { return .unreachable }
        return (200..<300).contains(reply.status) ? nil : .refused(Self.message(reply))
    }

    private static func message(_ reply: ReplyFrame) -> String {
        reply.body?["error"]?.stringValue ?? "The Mac refused it (\(reply.status))."
    }

    private func saved() {
        seenAt = Date().timeIntervalSince1970
        cache.save(EosSnapshot(routines: routines, inbox: inbox, seenAt: seenAt), device: deviceId)
    }
}

enum EosRefusal: Error, Equatable {
    /// The Mac is not connected.
    case unreachable
    case refused(String)

    var text: String {
        switch self {
        case .unreachable: return "Your Mac isn't connected."
        case .refused(let why): return why
        }
    }
}
