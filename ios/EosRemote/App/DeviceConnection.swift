import Foundation
import OSLog
import EosRemoteKit

private let eosLog = Logger(subsystem: "dev.eos.remote", category: "connect")

// One device's live connection + state (Phase 5a). This is the per-device port of the old single
// AppModel guts: it owns the WS connection, its own Store, the transcript pipeline (durable rows +
// live overlays + caches), and the connect/resume/backoff state machine. It is the WSConnection
// delegate, so a background device keeps folding its own frames while another device is on screen —
// that is what makes switchDevice instant (every paired device's Store is already live).
//
// AppModel holds one of these per device and MIRRORS the active one's fields into its @Published
// arrays. DeviceConnection is @MainActor (same thread as the views + Store callbacks) and calls
// `onChange` after any state mutation so AppModel can re-publish when this is the active device.
@MainActor
final class DeviceConnection: NSObject {
    let device: Device
    var deviceId: String { device.id }

    // Live snapshot the owner mirrors (kept as plain fields; the owner republishes on change).
    private(set) var workers: [Worker] = []
    private(set) var pending: [Pending] = []
    private(set) var connected = false
    private(set) var connecting = false
    private(set) var lastError: String?
    // Per-device authRejected latch: bad creds are a device-level error, NOT global needsPairing.
    private(set) var authRejected = false

    private(set) var transcript: [Block] = []
    private(set) var loadingOlder = false
    private(set) var hasOlder = false

    // Notify the owner (AppModel) that this device's mirrored state changed.
    var onChange: (() -> Void)?

    // MARK: connect state (per-device; ported verbatim)
    private var resumeRetries = 0
    private var lastStep = ""
    private let maxResumeRetries = 6
    private var intentionalStop = false

    // MARK: transcript pipeline (per-device; ported verbatim from AppModel)
    private var openId: String?
    private var durableRows: [String: JSONValue] = [:]
    private var durableBlockIds: Set<String> = []
    private var liveBuffers: [String: LiveBuffer] = [:]
    private var newestRowId = 0
    private var oldestRowId = 0
    private var deltaFetching = false
    private var deltaPending = false

    private struct OptimisticBubble { let text: String; let clientMsgId: String; let ts: Double; let workerId: String }
    private var optimisticBubbles: [OptimisticBubble] = []

    private struct LiveTerminal { var runId: String; var command: String; var output: String; var done: Bool; var exitCode: Int; var note: String?; var ts: Double }
    private var liveTerminals: [String: LiveTerminal] = [:]

    private var liveCheck: LoopCheckProgress?

    private var caches: [String: TranscriptCache] = [:]
    private struct TranscriptCache {
        var durableRows: [String: JSONValue]
        var durableBlockIds: Set<String>
        var newestRowId: Int
        var oldestRowId: Int
        var hasOlder: Bool
    }

    private let initialPageSize = 120
    private let olderPageSize = 500

    private struct LiveBuffer { var blockId: String; var channel: String; var text: String; var ts: Double }

    let store = Store()
    private var connection: WSConnection?
    private var session: SessionState?

    init(device: Device) {
        self.device = device
        super.init()
        Task { await store.setOnChange { [weak self] in Task { @MainActor in await self?.refresh() } } }
    }

    private func refresh() async {
        workers = await store.workerList.sorted { $0.id < $1.id }
        pending = await store.pendingList.sorted { $0.id < $1.id }
        onChange?()
    }

    var orchestrators: [Worker] { workers.filter { $0.isOrchestrator } }
    var plainWorkers: [Worker] { workers.filter { !$0.isOrchestrator } }

    func isBusy(_ id: String) -> Bool {
        guard let w = workers.first(where: { $0.id == id }) else { return false }
        switch w.state { case "WORKING", "SPAWNING", "ENDING", "KILLING": return true; default: return false }
    }

    // MARK: control actions (tunneled REST)

    func sendMessage(to id: String, text: String, queueWhenBusy: Bool = true) async {
        let clientMsgId = UUID().uuidString
        if openId == id {
            optimisticBubbles.append(OptimisticBubble(text: text, clientMsgId: clientMsgId,
                                                      ts: Date().timeIntervalSince1970 * 1000, workerId: id))
            recompute()
        }
        let body: JSONValue = .object([
            "text": .string(text),
            "clientMsgId": .string(clientMsgId),
            "queueWhenBusy": .bool(queueWhenBusy),
        ])
        await control("POST", "/workers/\(id)/message", body)
        if openId == id { scheduleDelta() }
    }

    func interrupt(_ id: String) async { await control("POST", "/workers/\(id)/interrupt", .object([:])) }

    func answerQuestion(workerId: String, toolUseId: String, answers: [String]) async {
        let body: JSONValue = .object([
            "toolUseId": .string(toolUseId),
            "answers": .array(answers.map { .string($0) }),
        ])
        await control("POST", "/workers/\(workerId)/question-answer", body)
    }

    func kill(_ id: String) async { await control("DELETE", "/workers/\(id)", .object([:])) }

    @discardableResult
    func rewind(workerId: String, text: String) async -> Bool {
        guard let connection else { setError("not connected"); return false }
        let reply = try? await connection.sendControl(method: "GET",
            path: "/workers/\(workerId)/rewind-targets", bodyData: Data("{}".utf8))
        let targets = reply?.body?["targets"]?.arrayValue ?? []
        let want = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let match = targets.last { t in
            let tt = (t["text"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let dd = (t["display"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return tt == want || dd == want
        } ?? targets.last
        guard let uuid = match?["uuid"]?.stringValue else { setError("no rewind target"); return false }
        await control("POST", "/workers/\(workerId)/rewind",
                      .object(["uuid": .string(uuid), "mode": .string("conversation")]))
        if openId == workerId { scheduleDelta() }
        return true
    }

    func spawnWorker(body: JSONValue) async { await control("POST", "/workers", body) }
    func approve(pendingId: String, allow: Bool) async {
        await control("POST", "/pending/\(pendingId)/decision",
                      .object(["decision": .string(allow ? "allow" : "deny")]))
    }

    private func encodeOnce(_ body: JSONValue) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }

    private func control(_ method: String, _ path: String, _ body: JSONValue) async {
        guard let connection else { setError("not connected"); return }
        do { _ = try await connection.sendControl(method: method, path: path, bodyData: encodeOnce(body)) }
        catch { setError(error.localizedDescription) }
    }

    // MARK: connect / resume — one path, ported verbatim but per-device

    // Connect this device from its stored creds. Same open → join → live path as before; on success
    // CONNECTED, on BEARER_DENIED a per-device error (authRejected), on transient a bounded backoff.
    func connect() async {
        guard !connected, !connecting else { return }
        guard let relayURL = device.relayURL else { setError("bad relay url"); return }
        connecting = true; authRejected = false; intentionalStop = false
        onChange?()
        defer { connecting = false; onChange?() }
        let conn = WSConnection(url: relayURL, delegate: self)
        do {
            let result = try await Connector(connection: conn, room: device.room,
                                             bearer: device.bearer ?? "", log: stepLogger()).run()
            self.connection = conn
            self.session = result.session
            resumeRetries = 0; connected = true; lastError = nil
            eosLog.info("connect[\(self.deviceId, privacy: .public)]: OK")
            await bootstrap()
        } catch Connector.ConnectError.authRejected {
            await conn.stop()
            eosLog.error("connect[\(self.deviceId, privacy: .public)]: BEARER_DENIED (rotated)")
            lastError = "This device is no longer paired. Pair it again."
            authRejected = true
        } catch {
            await conn.stop()
            eosLog.error("connect[\(self.deviceId, privacy: .public)]: transient \(String(describing: error), privacy: .public)")
            lastError = diag("connect", error); scheduleResumeRetry()
        }
    }

    private func stepLogger() -> @Sendable (String) -> Void {
        { [weak self] s in Task { @MainActor in self?.lastStep = s } }
    }

    private func diag(_ phase: String, _ error: Error) -> String {
        let code: String
        switch error {
        case Connector.ConnectError.authRejected: code = "auth rejected"
        case Connector.ConnectError.transient(let c): code = c
        case WSConnection.WSError.timeout: code = "timeout (no daemon reply)"
        default: code = String(describing: error)
        }
        return "\(phase) failed at [\(lastStep)]: \(code) — try \(resumeRetries)/\(maxResumeRetries)"
    }

    // Bounded backoff for transient failures. Unlike the single-device model, exhausting the budget
    // does NOT force global needsPairing — it lands on a per-device error the Devices UI surfaces.
    private func scheduleResumeRetry() {
        guard resumeRetries < maxResumeRetries else {
            connecting = false
            if lastError == nil { lastError = "Couldn't reconnect to this device." }
            onChange?()
            return
        }
        let delay = min(pow(2.0, Double(resumeRetries)), 30.0)
        resumeRetries += 1
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if !connected && !intentionalStop { await connect() }
        }
    }

    func enterForeground() async { resumeRetries = 0; await connect() }

    // Drop the socket on background; foreground reconnects. Keeps caches + creds.
    func enterBackground() async {
        intentionalStop = true
        await connection?.stop()
        connection = nil
        connected = false
        onChange?()
    }

    // Tear the socket down (device removed / app-level disconnect). Does NOT wipe creds — the caller
    // (DeviceStore) owns credential lifetime.
    func teardown() async {
        intentionalStop = true
        await connection?.stop()
        connection = nil; session = nil
        connected = false; connecting = false
        openId = nil; transcript = []
        onChange?()
    }

    private func bootstrap() async {
        guard let connection else { return }
        async let w = try? connection.sendControl(method: "GET", path: "/workers", bodyData: Data("{}".utf8))
        async let p = try? connection.sendControl(method: "GET", path: "/pending", bodyData: Data("{}".utf8))
        let workers = (await w)?.body?.arrayValue ?? []
        let pending = (await p)?.body?.arrayValue ?? []
        await store.applyBootstrap(workers: workers, pending: pending)
    }

    private func setError(_ message: String) { lastError = message; onChange?() }

    // MARK: live transcript (ported verbatim, per-device)

    func openWorker(_ id: String) async {
        openId = id
        liveBuffers = [:]
        liveTerminals = [:]
        liveCheck = nil
        optimisticBubbles.removeAll { $0.workerId != id }
        if let c = caches[id] {
            durableRows = c.durableRows; durableBlockIds = c.durableBlockIds
            newestRowId = c.newestRowId; oldestRowId = c.oldestRowId; hasOlder = c.hasOlder
            recompute()
            await fetchDelta()
        } else {
            durableRows = [:]; durableBlockIds = []
            newestRowId = 0; oldestRowId = 0; hasOlder = false
            transcript = []
            await fetchNewest()
        }
    }

    func closeWorker(_ id: String) {
        guard openId == id else { return }
        caches[id] = TranscriptCache(durableRows: durableRows, durableBlockIds: durableBlockIds,
                                     newestRowId: newestRowId, oldestRowId: oldestRowId, hasOlder: hasOlder)
        openId = nil
        liveBuffers = [:]
        liveTerminals = [:]
        liveCheck = nil
    }

    func loadOlder() async {
        guard let id = openId, hasOlder, oldestRowId > 0, !loadingOlder else { return }
        loadingOlder = true; onChange?()
        defer { loadingOlder = false; onChange?() }
        guard let rows = await fetchEvents("order=desc&beforeId=\(oldestRowId)&limit=\(olderPageSize)"),
              openId == id else { return }
        hasOlder = rows.count >= olderPageSize
        ingest(rows, workerId: id)
    }

    private func fetchEvents(_ query: String) async -> [JSONValue]? {
        guard let connection, let id = openId else { return nil }
        let reply = try? await connection.sendControl(method: "GET",
            path: "/workers/\(id)/events?\(query)", bodyData: Data("{}".utf8))
        return reply?.body?.arrayValue
    }

    private func fetchNewest() async {
        guard let id = openId,
              let rows = await fetchEvents("limit=\(initialPageSize)&order=desc"), openId == id else { return }
        hasOlder = rows.count >= initialPageSize
        ingest(rows, workerId: id)
    }

    private func fetchDelta() async {
        guard let id = openId else { return }
        if newestRowId == 0 { await fetchNewest(); return }
        guard let rows = await fetchEvents("afterId=\(newestRowId)&limit=500"), openId == id, !rows.isEmpty else { return }
        ingest(rows, workerId: id)
    }

    private func scheduleDelta() {
        if deltaFetching { deltaPending = true; return }
        deltaFetching = true
        Task { @MainActor in
            await fetchDelta()
            deltaFetching = false
            if deltaPending { deltaPending = false; scheduleDelta() }
        }
    }

    private func ingest(_ rows: [JSONValue], workerId: String) {
        for r in rows {
            guard let rid = r["id"]?.intValue else { continue }
            newestRowId = max(newestRowId, rid)
            oldestRowId = oldestRowId == 0 ? rid : min(oldestRowId, rid)
            durableRows[String(rid)] = r
        }
        recompute()
    }

    private func collectDurableBlockIds() {
        for r in durableRows.values {
            let p = (r["payload"].flatMap { if case .string(let s) = $0 { return JSONValue.parse(s) } else { return $0 } }) ?? .null
            if p["type"]?.stringValue == "message" {
                for b in p["blocks"]?.arrayValue ?? [] {
                    if let bid = b["blockId"]?.stringValue { durableBlockIds.insert(bid); liveBuffers[bid] = nil }
                }
            } else if let bid = p["blockId"]?.stringValue {
                durableBlockIds.insert(bid); liveBuffers[bid] = nil
            }
        }
    }

    private func applyDelta(_ payload: JSONValue?) {
        guard let id = openId,
              payload?["workerId"]?.stringValue == id,
              let blockId = payload?["blockId"]?.stringValue,
              !durableBlockIds.contains(blockId) else { return }
        if let phase = payload?["phase"]?.stringValue, phase == "stop" || phase == "end" { return }
        let channel = payload?["channel"]?.stringValue ?? "reasoning"
        var buf = liveBuffers[blockId] ?? LiveBuffer(blockId: blockId, channel: channel, text: "",
                                                     ts: Date().timeIntervalSince1970 * 1000)
        buf.channel = channel
        buf.text += payload?["text"]?.stringValue ?? ""
        liveBuffers[blockId] = buf
        recompute()
    }

    func handleTranscriptEvent(_ event: EventFrame) {
        switch event.reason {
        case "agent:delta": applyDelta(event.payload)
        case "worker:change": if event.payload?["workerId"]?.stringValue == openId { scheduleDelta() }
        case "terminal:chunk": applyTerminalChunk(event.payload)
        case "terminal:done": applyTerminalDone(event.payload)
        case "loop:check": applyLoopCheck(event.payload)
        default: break
        }
    }

    private func applyTerminalChunk(_ payload: JSONValue?) {
        guard let id = openId, payload?["workerId"]?.stringValue == id,
              let runId = payload?["runId"]?.stringValue else { return }
        var run = liveTerminals[runId] ?? LiveTerminal(runId: runId, command: "", output: "", done: false,
                                                       exitCode: 0, note: nil, ts: Date().timeIntervalSince1970 * 1000)
        if let cmd = payload?["command"]?.stringValue, !cmd.isEmpty { run.command = cmd }
        run.output += payload?["data"]?.stringValue ?? ""
        liveTerminals[runId] = run
        recompute()
    }

    private func applyTerminalDone(_ payload: JSONValue?) {
        guard let runId = payload?["runId"]?.stringValue, var run = liveTerminals[runId] else { return }
        run.done = true
        run.exitCode = payload?["exitCode"]?.intValue ?? 0
        run.note = payload?["note"]?.stringValue
        liveTerminals[runId] = run
        recompute()
    }

    private func applyLoopCheck(_ payload: JSONValue?) {
        guard let id = openId, payload?["workerId"]?.stringValue == id,
              let phase = payload?["phase"]?.stringValue else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let startedAt = phase == "started" ? now : (liveCheck?.startedAt ?? now)
        liveCheck = LoopCheckProgress(
            workerId: id, attempt: payload?["attempt"]?.intValue ?? 0, maxAttempts: payload?["maxAttempts"]?.intValue,
            strategy: payload?["strategy"]?.stringValue, phase: phase, criterionId: payload?["criterionId"]?.stringValue,
            met: payload?["met"]?.boolValue, outcome: payload?["outcome"]?.stringValue,
            reason: payload?["reason"]?.stringValue, startedAt: startedAt)
        if phase == "verdict" {
            let captured = liveCheck
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if self.liveCheck?.startedAt == captured?.startedAt { self.liveCheck = nil; self.onChange?() }
            }
        }
        onChange?()
    }

    func activeGoalCheck(for id: String) -> LoopCheckProgress? {
        guard let c = liveCheck, c.workerId == id else { return nil }
        return isBusy(id) ? nil : c
    }

    func loopHistory(for id: String) -> [LoopCheck] {
        transcript.compactMap { b in
            guard b.workerId == id, case let .loopCheck(check) = b.payload else { return nil }
            return check
        }
    }

    private func recompute() {
        durableBlockIds = []
        collectDurableBlockIds()
        let rows = Array(durableRows.values)
        var all = MessageNormalizer.buildBlocks(rows, workerId: openId ?? "")
        for buf in liveBuffers.values where !durableBlockIds.contains(buf.blockId) {
            let payload: Block.Payload = buf.channel == "reasoning"
                ? .thinking(text: buf.text) : .assistant(text: buf.text)
            all.append(Block(id: "live:\(buf.blockId)", workerId: openId ?? "", blockId: buf.blockId,
                             ts: buf.ts, live: true, payload: payload))
        }
        let durableRunIds = Set(all.compactMap { b -> String? in
            if case let .terminal(t) = b.payload { return t.runId }
            return nil
        })
        for runId in Array(liveTerminals.keys) where durableRunIds.contains(runId) { liveTerminals[runId] = nil }
        for run in liveTerminals.values {
            all.append(Block(id: "live-term:\(run.runId)", workerId: openId ?? "", ts: run.ts, live: true,
                             payload: .terminal(Terminal(runId: run.runId, command: run.command, output: run.output,
                                                         exitCode: run.exitCode, note: run.note, truncated: false,
                                                         done: run.done))))
        }
        let durableUserTexts = Set(all.compactMap { b -> String? in
            if case let .user(t, _) = b.payload { return t.trimmingCharacters(in: .whitespacesAndNewlines) }
            return nil
        })
        optimisticBubbles.removeAll { durableUserTexts.contains($0.text.trimmingCharacters(in: .whitespacesAndNewlines)) }
        for bubble in optimisticBubbles where bubble.workerId == openId {
            all.append(Block(id: "optimistic:\(bubble.clientMsgId)", workerId: bubble.workerId,
                             ts: bubble.ts, payload: .user(text: bubble.text, optimistic: true)))
        }
        transcript = sortBlocksByTs(all)
        onChange?()
    }
}

// WSConnection delegate — fold this device's frames into ITS store on the main actor, then notify.
extension DeviceConnection: WSConnectionDelegate {
    nonisolated func wsDidReceive(snapshot: SnapshotFrame) async { await store.applySnapshot(snapshot) }
    nonisolated func wsDidReceive(patch: PatchFrame) async { _ = await store.applyPatch(patch) }
    nonisolated func wsDidReceive(event: EventFrame) async {
        _ = await store.applyEvent(event)
        await handleTranscriptEvent(event)
    }
    nonisolated func wsDidReceive(error: ErrorFrame) async {
        await MainActor.run { self.setError("\(error.code): \(error.message ?? "")") }
    }
    nonisolated func wsConnectionStateChanged(connected: Bool) async {
        await MainActor.run {
            self.connected = connected
            self.onChange?()
            if !connected && !self.intentionalStop && !self.connecting {
                self.resumeRetries = 0
                self.scheduleResumeRetry()
            }
        }
    }
}
