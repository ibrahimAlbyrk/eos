import Foundation
import SwiftUI
import OSLog
import EosRemoteKit

// Surfaced in Console.app / `log stream --predicate 'subsystem == "dev.eos.remote"'` so the
// resume → cold-connect → pair fallback can be diagnosed on a device that isn't Xcode-attached.
private let eosLog = Logger(subsystem: "dev.eos.remote", category: "connect")

// The @MainActor bridge between the live store/transport (EosRemoteKit) and SwiftUI. It is the
// WSConnection delegate: server frames land here, fold into the Store actor, and surface as
// @Published arrays the screens observe. Control actions tunnel REST over the WS.
@MainActor
final class AppModel: ObservableObject {
    @Published var workers: [Worker] = []
    @Published var pending: [Pending] = []
    @Published var connected = false
    @Published var connecting = false
    // True when there are no usable stored credentials (never paired, or the ticket expired / was
    // rejected) — the UI shows the Pair screen instead of a dead "disconnected" banner.
    @Published var needsPairing = false
    @Published var lastError: String?
    private var resumeRetries = 0
    // Last handshake step the active coordinator reported (join-ack / RES-1 / CONNECT-3 / …). Captured
    // so a failure can name exactly where it died — surfaced on screen since on-device log capture
    // needs root. Updated off the main actor by the coordinator's log closure.
    private var lastStep = ""
    private let maxResumeRetries = 6
    // True while a socket teardown is deliberate (background/disconnect), so the delegate's
    // connected=false doesn't kick off a reconnect we don't want.
    private var intentionalStop = false

    // Live transcript of the currently-open worker (design §5.2, port of eventsStore+thinkingStore).
    // Durable rows page in via control GET /workers/:id/events; agent:delta overlays live
    // streaming text/thinking until the durable block lands; a worker:change nudge pulls new rows.
    @Published var transcript: [Block] = []
    @Published var loadingOlder = false
    private(set) var hasOlder = false

    private var openId: String?
    private var durableBlocks: [String: Block] = [:]   // display id → block
    private var durableBlockIds: Set<String> = []      // blockIds with a durable block (live drop guard)
    private var liveBuffers: [String: LiveBuffer] = [:] // blockId → streaming overlay
    private var newestRowId = 0
    private var oldestRowId = 0
    private var deltaFetching = false
    private var deltaPending = false

    // Per-worker durable transcript, retained across close/reopen so reopening never reloads from
    // scratch: openWorker restores instantly from here, then fetches ONLY rows after newestRowId.
    private var caches: [String: TranscriptCache] = [:]
    private struct TranscriptCache {
        var durableBlocks: [String: Block]
        var durableBlockIds: Set<String>
        var newestRowId: Int
        var oldestRowId: Int
        var hasOlder: Bool
    }

    // Smaller first page → fast first paint; older history backfills on scroll-up via loadOlder.
    private let initialPageSize = 120
    private let olderPageSize = 500

    private struct LiveBuffer { var blockId: String; var channel: String; var text: String; var ts: Double }

    let store = Store()
    private var connection: WSConnection?
    private var session: SessionState?

    init() {
        Task { await store.setOnChange { [weak self] in Task { @MainActor in await self?.refresh() } } }
    }

    private func refresh() async {
        workers = await store.workerList.sorted { $0.id < $1.id }
        pending = await store.pendingList.sorted { $0.id < $1.id }
    }

    var orchestrators: [Worker] { workers.filter { $0.isOrchestrator } }
    var plainWorkers: [Worker] { workers.filter { !$0.isOrchestrator } }

    // MARK: control actions (tunneled REST)

    func sendMessage(to id: String, text: String, queueWhenBusy: Bool = true) async {
        let body: JSONValue = .object([
            "text": .string(text),
            "clientMsgId": .string(UUID().uuidString),
            "queueWhenBusy": .bool(queueWhenBusy),
        ])
        await control("POST", "/workers/\(id)/message", body)
        // Pull the just-logged user_message row so the sent message appears immediately, without
        // waiting for the worker:change nudge to round-trip.
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

    // High-risk verbs (kill/spawn/decision). There is no per-action step-up: possession of the room
    // capability grants full authority, so these dispatch like any other control.
    func kill(_ id: String) async { await control("DELETE", "/workers/\(id)", .object([:])) }
    func spawnWorker(body: JSONValue) async { await control("POST", "/workers", body) }
    func approve(pendingId: String, allow: Bool) async {
        await control("POST", "/pending/\(pendingId)/decision",
                      .object(["decision": .string(allow ? "allow" : "deny")]))
    }

    // Serialize the body EXACTLY ONCE → the daemon dispatches these exact bytes as the opaque body
    // string (§5.2.3), so there is nothing for the two ends to disagree on.
    private func encodeOnce(_ body: JSONValue) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }

    private func control(_ method: String, _ path: String, _ body: JSONValue) async {
        guard let connection else { lastError = "not connected"; return }
        do { _ = try await connection.sendControl(method: method, path: path, bodyData: encodeOnce(body)) }
        catch { lastError = error.localizedDescription }
    }

    // MARK: pairing + bootstrap

    // First connect (§6.1): the scanned v3 QR carries the whole credential (relay, room, bearer).
    // Persist the three Keychain items, then run the collapsed open → join → live connector. No
    // enrollment handshake — the bearer IS the join credential.
    func startPairing(qr: QRPayload) async {
        do {
            guard let relayURL = qr.relayURL else { throw PairingError.noRelayURL }
            guard let bearer = qr.bearer else { throw PairingError.noBearer }
            let conn = WSConnection(url: relayURL, delegate: self)
            let result = try await Connector(
                connection: conn, room: qr.room, bearer: bearer, log: stepLogger()).run()
            self.connection = conn
            self.session = result.session
            // Everything a reconnect needs: the three room-capability values.
            try? KeychainStore.set(KeychainStore.relayURL, Data(relayURL.absoluteString.utf8))
            try? KeychainStore.set(KeychainStore.room, Data(qr.room.utf8))
            try? KeychainStore.set(KeychainStore.bearer, Data(bearer.utf8))
            needsPairing = false; resumeRetries = 0; intentionalStop = false
            connected = true
            await bootstrap()
        } catch { lastError = "pairing failed: \(error)" }
    }

    // MARK: persistent connection — one path, two terminal states (§6)

    // Called on launch and every foreground. ONE connect path used identically every time (§6.2):
    // read the three room-capability values from the Keychain and run open → join → live. There is
    // no handshake, so "resume" and "connect" are the same code path. Face-ID-free, no QR unless the
    // relay rejects the bearer.
    //   success                       → CONNECTED
    //   authRejected (BEARER_DENIED)  → NEEDS_PAIRING (room/bearer rotated; show QR)
    //   transient (net/room-gone)     → bounded backoff → manual Reconnect (never an infinite loop)
    func resumeIfPossible() async {
        guard !connected, !connecting else { return }
        guard let relayURL = storedRelayURL(), let room = storedRoom(), let bearer = storedBearer()
        else { eosLog.info("connect: no stored credential → show QR"); needsPairing = true; return }

        connecting = true; needsPairing = false; intentionalStop = false
        defer { connecting = false }
        let conn = WSConnection(url: relayURL, delegate: self)
        do {
            let result = try await Connector(connection: conn, room: room, bearer: bearer,
                                             log: stepLogger()).run()
            self.connection = conn
            self.session = result.session
            resumeRetries = 0; connected = true
            eosLog.info("connect: OK")
            await bootstrap()
        } catch Connector.ConnectError.authRejected {
            await conn.stop()
            eosLog.error("connect: BEARER_DENIED (rotated) → show QR")
            lastError = "This device is no longer paired. Pair again."
            needsPairing = true
        } catch {
            await conn.stop()
            eosLog.error("connect: transient \(String(describing: error), privacy: .public) → retry")
            lastError = diag("connect", error); scheduleResumeRetry()
        }
    }

    // A @Sendable step recorder for the connector — folds each step marker onto the main actor so a
    // later failure can report the exact step it reached.
    private func stepLogger() -> @Sendable (String) -> Void {
        { [weak self] s in Task { @MainActor in self?.lastStep = s } }
    }

    // One human-readable diagnostic line: phase + the step it died on + the cause + retry count.
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

    private func storedRelayURL() -> URL? {
        guard let d = KeychainStore.get(KeychainStore.relayURL),
              let s = String(data: d, encoding: .utf8) else { return nil }
        return URL(string: s)
    }

    private func storedRoom() -> String? {
        guard let d = KeychainStore.get(KeychainStore.room) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private func storedBearer() -> String? {
        guard let d = KeychainStore.get(KeychainStore.bearer) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    // Backoff for transient resume failures (network flaky). Reset on success / fresh foreground.
    // Bounded: once the budget is spent the loop CONVERGES to an actionable terminal state — the Pair
    // sheet (also always reachable from the toolbar) — rather than cycling reconnecting↔connecting
    // forever. A fresh foreground resets the budget and tries again, so a transient outage recovers.
    private func scheduleResumeRetry() {
        guard resumeRetries < maxResumeRetries else {
            connecting = false
            needsPairing = true   // RootView auto-presents the Pair sheet — a re-pair that works
            if lastError == nil { lastError = "Couldn't reconnect. Pair again." }
            return
        }
        let delay = min(pow(2.0, Double(resumeRetries)), 30.0)   // 1,2,4,8,16,30s
        resumeRetries += 1
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if !connected { await resumeIfPossible() }
        }
    }

    func enterForeground() async { resumeRetries = 0; await resumeIfPossible() }

    // Dropping the socket on background is fine — foreground re-resumes via the ticket.
    func enterBackground() async {
        intentionalStop = true
        await connection?.stop()
        connection = nil
        connected = false
    }

    // Explicit Disconnect/Unpair (§6.3): tear down the session and forget the three room-capability
    // Keychain items. Next launch → NEEDS_PAIRING (show QR).
    func disconnect() async {
        intentionalStop = true
        await connection?.stop()
        connection = nil; session = nil
        connected = false; connecting = false
        openId = nil; transcript = []
        for key in [KeychainStore.relayURL, KeychainStore.room, KeychainStore.bearer] {
            KeychainStore.delete(key)
        }
        needsPairing = true
    }

    // Cold-start state pull: READ-tier GETs feed a synthetic snapshot until snapshot-on-hello lands.
    private func bootstrap() async {
        guard let connection else { return }
        async let w = try? connection.sendControl(method: "GET", path: "/workers", bodyData: Data("{}".utf8))
        async let p = try? connection.sendControl(method: "GET", path: "/pending", bodyData: Data("{}".utf8))
        let workers = (await w)?.body?.arrayValue ?? []
        let pending = (await p)?.body?.arrayValue ?? []
        await store.applyBootstrap(workers: workers, pending: pending)
    }

    private enum PairingError: Error { case noRelayURL, noBearer }

    // MARK: live transcript

    // Open a worker's transcript. On reopen, restore the cached durable blocks for an INSTANT paint,
    // then fetch only the rows appended since (afterId = newestRowId). First-ever open pages in the
    // newest events. Live deltas + worker:change nudges keep it current until closeWorker.
    func openWorker(_ id: String) async {
        openId = id
        liveBuffers = [:]
        if let c = caches[id] {
            durableBlocks = c.durableBlocks; durableBlockIds = c.durableBlockIds
            newestRowId = c.newestRowId; oldestRowId = c.oldestRowId; hasOlder = c.hasOlder
            recompute()                 // instant render from cache — no reload-from-scratch
            await fetchDelta()          // append only the new rows
        } else {
            durableBlocks = [:]; durableBlockIds = []
            newestRowId = 0; oldestRowId = 0; hasOlder = false
            transcript = []
            await fetchNewest()
        }
    }

    // Snapshot the durable transcript into the cache so the next open is instant; keep the cache.
    func closeWorker(_ id: String) {
        guard openId == id else { return }
        caches[id] = TranscriptCache(durableBlocks: durableBlocks, durableBlockIds: durableBlockIds,
                                     newestRowId: newestRowId, oldestRowId: oldestRowId, hasOlder: hasOlder)
        openId = nil
        liveBuffers = [:]
    }

    // Scroll-to-top backward paging.
    func loadOlder() async {
        guard let id = openId, hasOlder, oldestRowId > 0, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
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

    // Forward delta: only the rows appended after the highest loaded id (afterId overrides order).
    private func fetchDelta() async {
        guard let id = openId else { return }
        if newestRowId == 0 { await fetchNewest(); return }
        guard let rows = await fetchEvents("afterId=\(newestRowId)&limit=500"), openId == id, !rows.isEmpty else { return }
        ingest(rows, workerId: id)
    }

    // Coalesce a burst of worker:change nudges into one in-flight delta fetch.
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
        }
        for b in MessageNormalizer.normalize(rows, workerId: workerId) {
            durableBlocks[b.id] = b
            if let bid = b.blockId { durableBlockIds.insert(bid); liveBuffers[bid] = nil } // flicker-free handoff
        }
        recompute()
    }

    // agent:delta payload {workerId, blockId, channel, phase, text} — append to the live overlay.
    private func applyDelta(_ payload: JSONValue?) {
        guard let id = openId,
              payload?["workerId"]?.stringValue == id,
              let blockId = payload?["blockId"]?.stringValue,
              !durableBlockIds.contains(blockId) else { return }   // durable already landed
        if let phase = payload?["phase"]?.stringValue, phase == "stop" || phase == "end" { return }
        let channel = payload?["channel"]?.stringValue ?? "reasoning"
        var buf = liveBuffers[blockId] ?? LiveBuffer(blockId: blockId, channel: channel, text: "",
                                                     ts: Date().timeIntervalSince1970 * 1000)
        buf.channel = channel
        buf.text += payload?["text"]?.stringValue ?? ""
        liveBuffers[blockId] = buf
        recompute()
    }

    @MainActor private func handleTranscriptEvent(_ event: EventFrame) {
        switch event.reason {
        case "agent:delta": applyDelta(event.payload)
        case "worker:change": if event.payload?["workerId"]?.stringValue == openId { scheduleDelta() }
        default: break
        }
    }

    private func recompute() {
        var all = Array(durableBlocks.values)
        for buf in liveBuffers.values {
            all.append(Block(id: "live:\(buf.blockId)", workerId: openId ?? "", blockId: buf.blockId,
                             kind: buf.channel == "reasoning" ? .thinking : .assistant,
                             ts: buf.ts, text: buf.text, raw: .null))
        }
        transcript = all.sorted { a, b in
            if a.ts != b.ts { return a.ts < b.ts }
            let an = rowNum(a.id), bn = rowNum(b.id)
            return an != bn ? an < bn : a.id < b.id
        }
    }

    private func rowNum(_ id: String) -> Int { Int(id.prefix(while: { $0.isNumber })) ?? 0 }
}

// WSConnection delegate — fold incoming frames into the store on the main actor.
extension AppModel: WSConnectionDelegate {
    nonisolated func wsDidReceive(snapshot: SnapshotFrame) async { await store.applySnapshot(snapshot) }
    nonisolated func wsDidReceive(patch: PatchFrame) async { _ = await store.applyPatch(patch) }
    nonisolated func wsDidReceive(event: EventFrame) async {
        _ = await store.applyEvent(event)
        await handleTranscriptEvent(event)
    }
    nonisolated func wsDidReceive(error: ErrorFrame) async {
        await MainActor.run { self.lastError = "\(error.code): \(error.message ?? "")" }
    }
    nonisolated func wsConnectionStateChanged(connected: Bool) async {
        await MainActor.run {
            self.connected = connected
            // Unexpected drop while in the foreground → auto-reconnect via the ticket with backoff.
            if !connected && !self.intentionalStop && !self.connecting {
                self.resumeRetries = 0
                self.scheduleResumeRetry()
            }
        }
    }
}
