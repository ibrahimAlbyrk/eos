import Foundation
import SwiftUI
import UIKit
import EosRemoteKit

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
    // True while a socket teardown is deliberate (background/disconnect), so the delegate's
    // connected=false doesn't kick off a reconnect we don't want.
    private var intentionalStop = false
    // Set when a HIGH-risk action is attempted on a resumed (read+low-risk) session: the UI must
    // drive a fresh cold connect/step-up rather than assume the resumed session can perform it.
    @Published var needsColdConnect = false

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

    private struct LiveBuffer { var blockId: String; var channel: String; var text: String; var ts: Double }

    let store = Store()
    private var connection: WSConnection?
    private var session: SessionState?
    private var identity: DeviceIdentity?

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

    // High-risk verbs (kill/spawn/decision) require step-up; the UI calls these knowing a Face ID
    // prompt may appear (§7.3). The challenge round-trip is wired by stepUpControl().
    func kill(_ id: String) async { await stepUpControl("DELETE", "/workers/\(id)", .object([:])) }
    func spawnWorker(body: JSONValue) async { await stepUpControl("POST", "/workers", body) }
    func approve(pendingId: String, allow: Bool) async {
        await stepUpControl("POST", "/pending/\(pendingId)/decision",
                            .object(["decision": .string(allow ? "allow" : "deny")]))
    }

    // Serialize the body EXACTLY ONCE → these bytes are both transmitted (as the opaque body
    // string) and, for step-up, hashed. One serialization = nothing for the two ends to disagree on.
    private func encodeOnce(_ body: JSONValue) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }

    private func control(_ method: String, _ path: String, _ body: JSONValue) async {
        guard let connection else { lastError = "not connected"; return }
        do { _ = try await connection.sendControl(method: method, path: path, bodyData: encodeOnce(body)) }
        catch { lastError = error.localizedDescription }
    }

    // Obtain a fresh challenge, build the step-up field over the EXACT transmitted body bytes, send.
    private func stepUpControl(_ method: String, _ path: String, _ body: JSONValue) async {
        guard let connection, let session, let identity else { lastError = "not connected"; return }
        // A resumed session is capped to read+low-risk: HIGH verbs would return CAP_DENIED even with
        // the Enclave key (3838e9d). Prompt a fresh cold connect instead of attempting + failing.
        if session.isResumed {
            needsColdConnect = true
            lastError = "This action needs a fresh secure connection (Face ID)."
            return
        }
        do {
            let bodyData = encodeOnce(body)
            let chReply = try await connection.sendControl(method: "POST", path: "/stepup/challenge",
                                                           bodyData: Data("{}".utf8))
            guard let nonceB64 = chReply.body?["challengeNonce"]?.stringValue,
                  let nonce = Bytes.fromB64u(nonceB64) else { lastError = "no challenge"; return }
            let coordinator = StepUpCoordinator(identity: identity, session: session)
            let ts = Int64(Date().timeIntervalSince1970)
            let field = try coordinator.field(method: method, path: path, bodyBytes: bodyData,
                                              challengeNonce: nonce, ts: ts, reason: "Authorize \(method) \(path)")
            _ = try await connection.sendControl(method: method, path: path, bodyData: bodyData, stepUp: field)
        } catch { lastError = error.localizedDescription }
    }

    // MARK: pairing + bootstrap

    // Run the cold PAIR choreography over a fresh relay connection, persist the durable bearer +
    // ticket, then bootstrap current state via READ controls (no snapshot-on-hello yet, daemon-side).
    func startPairing(qr: QRPayload, room: String, pairBearer: String) async {
        do {
            let relayURL = try relayWSURL(qr)
            let identity = try DeviceIdentityFactory.create()
            self.identity = identity
            let devId = UUID().uuidString
            let conn = WSConnection(url: relayURL, mode: .relay(bearer: pairBearer), delegate: self)
            let coordinator = PairingCoordinator(
                connection: conn, qr: qr, identity: identity, room: room, pairBearer: pairBearer,
                devId: devId, label: UIDevice.current.name)
            let result = try await coordinator.run()
            self.connection = conn
            self.session = result.session
            // Persist everything a warm resume needs after relaunch: durable bearer, rotated ticket,
            // relay coordinates, devId, and the Secure-Enclave key blob (the enrolled identity).
            try? KeychainStore.set(KeychainStore.durableBearer, Data(result.durableBearer.utf8))
            try? KeychainStore.set(KeychainStore.ticket, JSONEncoder().encode(result.ticket))
            try? KeychainStore.set(KeychainStore.relayURL, Data(relayURL.absoluteString.utf8))
            try? KeychainStore.set(KeychainStore.room, Data(room.utf8))
            try? KeychainStore.set(KeychainStore.devId, Data(devId.utf8))
            if let se = identity as? SecureEnclaveDeviceIdentity {
                try? KeychainStore.set(KeychainStore.deviceKeyBlob, se.dataRepresentation)
            }
            needsPairing = false; resumeRetries = 0; intentionalStop = false
            connected = true
            await bootstrap()
        } catch { lastError = "pairing failed: \(error)" }
    }

    // MARK: persistent connection — warm resume + lifecycle

    // Called on launch and on every foreground. If stored credentials exist and the ticket is
    // live, silently re-establishes the session over the wire (PSK-(EC)DHE, NO Face ID) so the app
    // opens already connected. Expired/rejected ticket → needsPairing (graceful re-pair), never a
    // dead disconnected screen. Transient network failure → backoff retry.
    func resumeIfPossible() async {
        guard !connected, !connecting else { return }
        guard let bearerData = KeychainStore.get(KeychainStore.durableBearer),
              let ticketData = KeychainStore.get(KeychainStore.ticket),
              let ticket = try? JSONDecoder().decode(ResumptionTicket.self, from: ticketData),
              let relayData = KeychainStore.get(KeychainStore.relayURL),
              let relayStr = String(data: relayData, encoding: .utf8), let relayURL = URL(string: relayStr),
              let roomData = KeychainStore.get(KeychainStore.room),
              let room = String(data: roomData, encoding: .utf8)
        else { needsPairing = true; return }   // never paired

        if !ticket.valid(now: Date().timeIntervalSince1970 * 1000) { needsPairing = true; return }

        let bearer = String(decoding: bearerData, as: UTF8.self)
        connecting = true; needsPairing = false; intentionalStop = false
        defer { connecting = false }
        // Restore the enrolled identity so a later step-up can sign; resume itself needs no signature.
        if self.identity == nil, let blob = KeychainStore.get(KeychainStore.deviceKeyBlob) {
            self.identity = try? SecureEnclaveDeviceIdentity.restore(dataRepresentation: blob)
        }
        let conn = WSConnection(url: relayURL, mode: .relay(bearer: bearer), delegate: self)
        do {
            let result = try await ResumeCoordinator(connection: conn, ticket: ticket,
                                                     room: room, durableBearer: bearer).run()
            self.connection = conn
            self.session = result.session
            try? KeychainStore.set(KeychainStore.ticket, JSONEncoder().encode(result.newTicket)) // rotation
            resumeRetries = 0
            connected = true
            await bootstrap()
        } catch {
            await conn.stop()
            // A relay/daemon rejection (expired/unknown ticket, bad binder) is not retryable → re-pair.
            if case ResumeCoordinator.ResumeError.denied = error { needsPairing = true }
            else { lastError = "resume failed: \(error)"; scheduleResumeRetry() }
        }
    }

    // Backoff for transient resume failures (network flaky). Reset on success / fresh foreground.
    private func scheduleResumeRetry() {
        guard resumeRetries < 6 else { return }
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

    // Explicit Disconnect/Unpair: tear down the session and forget all stored credentials.
    func disconnect() async {
        intentionalStop = true
        await connection?.stop()
        connection = nil; session = nil; identity = nil
        connected = false; connecting = false
        openId = nil; transcript = []
        for key in [KeychainStore.durableBearer, KeychainStore.ticket, KeychainStore.relayURL,
                    KeychainStore.room, KeychainStore.devId, KeychainStore.deviceKeyBlob] {
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

    private func relayWSURL(_ qr: QRPayload) throws -> URL {
        guard let s = qr.relay?.url, let u = URL(string: s) else { throw PairingCoordinator.PairError.denied("no relay url") }
        return u
    }

    // MARK: live transcript

    // Open a worker's transcript: clear prior state and page in the newest events. Live deltas +
    // worker:change nudges then keep it current until closeWorker.
    func openWorker(_ id: String) async {
        openId = id
        durableBlocks = [:]; durableBlockIds = []; liveBuffers = [:]
        newestRowId = 0; oldestRowId = 0; hasOlder = false
        transcript = []
        await fetchNewest()
    }

    func closeWorker(_ id: String) {
        guard openId == id else { return }
        openId = nil
        durableBlocks = [:]; durableBlockIds = []; liveBuffers = [:]
        transcript = []
    }

    // Scroll-to-top backward paging.
    func loadOlder() async {
        guard let id = openId, hasOlder, oldestRowId > 0, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let rows = await fetchEvents("order=desc&beforeId=\(oldestRowId)&limit=500"), openId == id else { return }
        hasOlder = rows.count >= 500
        ingest(rows, workerId: id)
    }

    private func fetchEvents(_ query: String) async -> [JSONValue]? {
        guard let connection, let id = openId else { return nil }
        let reply = try? await connection.sendControl(method: "GET",
            path: "/workers/\(id)/events?\(query)", bodyData: Data("{}".utf8))
        return reply?.body?.arrayValue
    }

    private func fetchNewest() async {
        guard let id = openId, let rows = await fetchEvents("limit=500&order=desc"), openId == id else { return }
        hasOlder = rows.count >= 500
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
    nonisolated func wsDidReceive(challenge: ChallengeFrame) async { /* delivered inline via reply */ }
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
