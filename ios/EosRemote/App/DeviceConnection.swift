import Foundation
import OSLog
import EosRemoteKit

private let eosLog = Logger(subsystem: "dev.eos.remote", category: "connect")
// Transcript-pipeline diagnostics: which live frames actually drive a render.
private let pipeLog = Logger(subsystem: "dev.eos.remote", category: "pipeline")

// One device's live connection + state (Phase 5a). This is the per-device port of the old single
// AppModel guts: it owns the WS connection, its own Store, the transcript pipeline (durable rows +
// live overlays + caches), and the connect/resume/backoff state machine. It is the WSConnection
// delegate, so a background device keeps folding its own frames while another device is on screen —
// that is what makes switchDevice instant (every paired device's Store is already live).
//
// AppModel holds one of these per device and MIRRORS the active one's fields into its @Published
// arrays. DeviceConnection is @MainActor (same thread as the views + Store callbacks) and calls
// `onChange` after any state mutation so AppModel can re-publish when this is the active device.
// The link itself (connect, retry, liveness) belongs to ConnectionSupervisor; this class only reacts
// to its frames and to it going live.
@MainActor
final class DeviceConnection: NSObject {
    let device: Device
    var deviceId: String { device.id }

    // Live snapshot the owner mirrors (kept as plain fields; the owner republishes on change).
    private(set) var workers: [Worker] = []
    private(set) var pending: [Pending] = []
    var connected: Bool { link.state == .live }
    // Anything short of live while the app is up: retries never stop in the foreground.
    var connecting: Bool { [.connecting, .syncing, .waiting].contains(link.state) }
    // Bootstrap phase (round 5, item B): false until the first authoritative workers
    // list lands (bootstrap GET / snapshot / fallback refresh). The Code list keeps
    // its skeleton while this is false — an empty list is unknown, not "no sessions".
    private(set) var workersLoaded = false
    // The link's failure while it is down; the last failed control while it is up.
    var lastError: String? { connected ? controlError : (link.lastError ?? controlError) }
    private var controlError: String?
    // Per-device: bad creds are a device-level error, NOT global needsPairing.
    var authRejected: Bool { link.state == .authRejected }

    private(set) var transcript: [Block] = []
    private(set) var loadingOlder = false
    private(set) var hasOlder = false

    // Redesign data surface (§H P2), mirrored like workers/pending: the ui-config cache (fetched
    // per connect + on demand) and the archived list (fetched lazily by the Archived filter).
    private(set) var uiConfig: UiConfig?
    private(set) var archived: [Worker] = []

    // Terminals: the daemon's PTY sessions (desktop Code-view panes), fetched per connect and kept
    // live by pty:session / pty:exit. pty:conversation / pty:data go to `onPtyEvent` (the open
    // terminal screen); `ptySubscription` is re-sent after every reconnect.
    private(set) var ptySessions: [PtySession] = []
    private(set) var ptySessionsLoaded = false
    var onPtyEvent: ((EventFrame) -> Void)?
    private var ptySubscription: [String] = []

    // Server-relative clock for the thinking/elapsed timer (round 5, item D):
    // sampled from every event frame's daemon-stamped ts.
    private(set) var turnClock = TurnClock()

    // Notify the owner (AppModel) that this device's mirrored state changed.
    var onChange: (() -> Void)?

    // MARK: transcript pipeline (per-device; ported verbatim from AppModel)
    private(set) var openId: String?
    // Durable rows are cached as PARSED `Ev`s keyed by rowId. The JSON-string payload decode in toEv
    // is the buildBlocks hotspot (~51ms of ~51ms for 2000 rows); parsing once at ingest instead of on
    // every recompute is the core Phase-6 win. Rows are append-only, so a cached Ev never goes stale.
    private var durableEvs: [String: Ev] = [:]
    private var durableBlockIds: Set<String> = []
    private var liveBuffers: [String: LiveBuffer] = [:]
    private var newestRowId = 0
    private var oldestRowId = 0
    private var deltaFetching = false
    private var deltaPending = false
    // Recompute coalescing: a burst of live frames (agent:delta / terminal:chunk / newest ingest)
    // collapses to ONE reparse+merge on the next runloop tick, mirroring the Mac's scheduleDelta
    // coalescing intent. recomputeScheduled guards re-entrancy inside a single burst.
    private var recomputeScheduled = false

    private struct OptimisticBubble { let text: String; let clientMsgId: String; let ts: Double; let workerId: String }
    private var optimisticBubbles: [OptimisticBubble] = []

    private struct LiveTerminal { var runId: String; var command: String; var output: String; var done: Bool; var exitCode: Int; var note: String?; var ts: Double }
    private var liveTerminals: [String: LiveTerminal] = [:]

    private var liveCheck: LoopCheckProgress?

    private var caches: [String: TranscriptCache] = [:]
    private struct TranscriptCache {
        var durableEvs: [String: Ev]
        var durableBlockIds: Set<String>
        var newestRowId: Int
        var oldestRowId: Int
        var hasOlder: Bool
    }

    private let initialPageSize = 120
    private let olderPageSize = 500
    private let deltaPageSize = 500

    private struct LiveBuffer { var blockId: String; var channel: String; var text: String; var ts: Double }

    let store = Store()
    private let link: ConnectionSupervisor<WSConnection>
    private var connection: WSConnection? { link.liveLink }

    init(device: Device) {
        self.device = device
        let room = device.room, bearer = device.bearer ?? ""
        // activate() refuses to start without a relay URL, so the unwrap only runs when it is set.
        link = ConnectionSupervisor { WSConnection(url: device.relayURL!, room: room, bearer: bearer) }
        super.init()
        link.onChange = { [weak self] in self?.onChange?() }
        link.onFrame = { [weak self] frame in await self?.handle(frame) }
        link.onLive = { [weak self] in self?.didGoLive() }
        link.resumeCursor = { [weak self] in await self?.store.lastSeq ?? 0 }
        Task { await store.setOnChange { [weak self] in Task { @MainActor in await self?.refresh() } } }
    }

    private func refresh() async {
        workers = await store.workerList.sorted { $0.id < $1.id }
        pending = await store.pendingList.sorted { $0.id < $1.id }
        workersLoaded = await store.workersLoaded
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
        // D-10 route split: orchestrators message via their own resource, plain workers as before.
        let isOrchestrator = workers.first(where: { $0.id == id })?.isOrchestrator == true
        await control("POST", isOrchestrator ? "/orchestrators/\(id)/message" : "/workers/\(id)/message", body)
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

    func approve(pendingId: String, allow: Bool) async {
        await control("POST", "/pending/\(pendingId)/decision",
                      .object(["decision": .string(allow ? "allow" : "deny")]))
    }

    private func encodeOnce(_ body: JSONValue) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }

    private func control(_ method: String, _ path: String, _ body: JSONValue) async {
        _ = await controlReply(method, path, body)
    }

    // Reply-returning variant for calls that read the body or the success bit. nil = transport
    // error or non-2xx (sendControl throws controlFailed on those); the error is surfaced.
    private func controlReply(_ method: String, _ path: String, _ body: JSONValue) async -> ReplyFrame? {
        guard let connection else { setError("not connected"); return nil }
        do { return try await connection.sendControl(method: method, path: path, bodyData: encodeOnce(body)) }
        catch { setError(error.localizedDescription); return nil }
    }

    // MARK: redesign data surface (§H P2) — new tunneled endpoints

    @discardableResult
    func fetchUiConfig() async -> UiConfig? {                     // GET /api/ui-config
        guard let body = (await controlReply("GET", "/api/ui-config", .object([:])))?.body,
              let config = UiConfig(raw: body) else { return nil }
        uiConfig = config
        onChange?()
        return config
    }

    func fetchArchived() async -> [Worker] {                      // GET /workers/archived
        let rows = (await controlReply("GET", "/workers/archived", .object([:])))?.body?.arrayValue ?? []
        archived = rows.map(Worker.init(raw:))
        onChange?()
        return archived
    }

    func archive(_ id: String) async -> Bool {                    // POST /workers/:id/archive
        await controlReply("POST", "/workers/\(id)/archive", .object([:])) != nil
    }

    func restore(_ id: String) async -> Bool {                    // POST /workers/:id/restore
        await controlReply("POST", "/workers/\(id)/restore", .object([:])) != nil
    }

    // GET /api/backends/:name/models — the model sheet's per-provider list. nil = transport/tier
    // failure; the sheet falls back to the profile's pinned model (fail-soft, Mac idiom).
    func fetchBackendModels(_ name: String) async -> BackendModels? {
        guard let body = (await controlReply("GET", "/api/backends/\(queryEscape(name))/models",
                                             .object([:])))?.body else { return nil }
        return BackendModels(raw: body)
    }

    func setModel(_ id: String, model: String, effort: String) async -> Bool {   // PUT /workers/:id/model
        await controlReply("PUT", "/workers/\(id)/model",
                           .object(["model": .string(model), "effort": .string(effort)])) != nil
    }

    func setPermissionMode(_ id: String, mode: String) async -> Bool {           // PUT /workers/:id/permission
        await controlReply("PUT", "/workers/\(id)/permission", .object(["mode": .string(mode)])) != nil
    }

    func addPolicyRule(tool: String) async {                      // POST /api/policy/rule — "Always allow"
        await control("POST", "/api/policy/rule",
                      .object(["tool": .string(tool), "behavior": .string("allow")]))
    }

    func setName(_ id: String, name: String?) async -> Bool {     // PUT /workers/:id/name — null resets to auto-name
        await controlReply("PUT", "/workers/\(id)/name",
                           .object(["name": name.map(JSONValue.string) ?? .null])) != nil
    }

    func renameIntent(_ id: String, active: Bool) async {         // PUT /workers/:id/rename-intent
        await control("PUT", "/workers/\(id)/rename-intent", .object(["active": .bool(active)]))
    }

    func spawnOrchestrator(cwd: String, model: String?, effort: String?, prompt: String,
                           permissionMode: String, backendProfile: String?) async -> String? {  // POST /orchestrators
        var body: [String: JSONValue] = [
            "cwd": .string(cwd),
            "prompt": .string(prompt),
            "permissionMode": .string(permissionMode),
        ]
        if let model { body["model"] = .string(model) }
        if let effort { body["effort"] = .string(effort) }
        if let backendProfile { body["backendProfile"] = .string(backendProfile) }
        return (await controlReply("POST", "/orchestrators", .object(body)))?.body?["id"]?.stringValue
    }

    func fetchRecents() async -> [String] {                       // GET /fs/recents
        let paths = (await controlReply("GET", "/fs/recents", .object([:])))?.body?["paths"]?.arrayValue ?? []
        return paths.compactMap(\.stringValue)
    }

    func listDirectories(cwd: String, dir: String?) async -> [FsDirEntry] {      // GET /fs/list, dirs only
        var query = "cwd=\(queryEscape(cwd))&limit=200"
        if let dir, !dir.isEmpty { query += "&dir=\(queryEscape(dir))" }
        let entries = (await controlReply("GET", "/fs/list?\(query)", .object([:])))?.body?["entries"]?.arrayValue ?? []
        return entries.compactMap { e in
            guard e["type"]?.stringValue == "directory",
                  let name = e["name"]?.stringValue,
                  let abs = e["absolutePath"]?.stringValue,
                  let rel = e["relativePath"]?.stringValue else { return nil }
            return FsDirEntry(name: name, absolutePath: abs, relativePath: rel)
        }
    }

    func uploadAttachment(name: String, data: Data) async -> String? {           // POST /fs/paste-b64
        let body: JSONValue = .object(["name": .string(name), "dataB64": .string(data.base64EncodedString())])
        return (await controlReply("POST", "/fs/paste-b64", body))?.body?["path"]?.stringValue
    }

    // MARK: terminals (PTY sessions) — tunneled /pty routes

    func fetchPtySessions() async {                               // GET /pty
        guard let connection,
              let rows = (try? await connection.sendControl(method: "GET", path: "/pty",
                                                             bodyData: Data("{}".utf8)))?.body?["sessions"]?.arrayValue
        else { return }
        applyPtySessions(rows)
    }

    func createPty(cwd: String, claude: Bool) async -> PtySession? {             // POST /pty
        var body: [String: JSONValue] = [
            "cols": .number(120), "rows": .number(32), "cwd": .string(cwd), "remote": .bool(true),
        ]
        if claude { body["claude"] = .object([:]) }
        guard let raw = (await controlReply("POST", "/pty", .object(body)))?.body,
              raw["sessionId"]?.stringValue != nil else { return nil }
        let session = PtySession(raw: raw)
        upsertPty(session)
        return session
    }

    func killPty(_ id: String) async -> Bool {                    // DELETE /pty/:id
        guard await controlReply("DELETE", "/pty/\(id)", .object([:])) != nil else { return false }
        ptySessions.removeAll { $0.id == id }
        onChange?()
        return true
    }

    func ptyBuffer(_ id: String) async -> (seq: Int, data: String)? {           // GET /pty/:id/buffer
        guard let body = (await controlReply("GET", "/pty/\(id)/buffer", .object([:])))?.body else { return nil }
        return (body["seq"]?.intValue ?? 0, body["data"]?.stringValue ?? "")
    }

    func ptyInput(_ id: String, data: String) async -> Bool {                    // POST /pty/:id/input
        await controlReply("POST", "/pty/\(id)/input", .object(["data": .string(data)])) != nil
    }

    func ptyConversation(_ id: String, afterId: Int) async -> JSONValue? {       // GET /pty/:id/conversation
        (await controlReply("GET", "/pty/\(id)/conversation?afterId=\(afterId)", .object([:])))?.body
    }

    enum PtyMessageResult { case sent, rejected, failed }

    // 409 = Claude isn't taking a prompt (a question is pending, or it exited to the shell) — the
    // screen explains it inline, so it doesn't count as a connection error.
    func ptyMessage(_ id: String, text: String) async -> PtyMessageResult {      // POST /pty/:id/message
        guard let connection else { setError("not connected"); return .failed }
        do {
            _ = try await connection.sendControl(method: "POST", path: "/pty/\(id)/message",
                                                 bodyData: encodeOnce(.object(["text": .string(text)])))
            return .sent
        } catch WSConnection.WSError.controlFailed(409) {
            return .rejected
        } catch {
            setError(error.localizedDescription)
            return .failed
        }
    }

    func ptyAnswer(_ id: String, toolUseId: String, answers: [PendingAnswer]) async -> Bool {   // POST /pty/:id/answer
        await controlReply("POST", "/pty/\(id)/answer",
                           .object(["toolUseId": .string(toolUseId), "answers": .array(answers.map(\.json))])) != nil
    }

    func ptyApprovePlan(_ id: String, toolUseId: String) async -> Bool {         // POST /pty/:id/answer
        await controlReply("POST", "/pty/\(id)/answer",
                           .object(["toolUseId": .string(toolUseId), "approve": .bool(true)])) != nil
    }

    func setPtySubscription(_ ids: [String]) async {
        guard ids != ptySubscription else { return }
        ptySubscription = ids
        await connection?.sendSubscription(pty: ids)
    }

    private func applyPtySessions(_ rows: [JSONValue]) {
        ptySessions = rows.map(PtySession.init(raw:)).sorted { $0.number < $1.number }
        ptySessionsLoaded = true
        onChange?()
    }

    private func upsertPty(_ session: PtySession) {
        if let i = ptySessions.firstIndex(where: { $0.id == session.id }) {
            ptySessions[i] = session
        } else {
            ptySessions.append(session)
            ptySessions.sort { $0.number < $1.number }
        }
        onChange?()
    }

    func handlePtyEvent(_ event: EventFrame) {
        switch event.reason {
        case "pty:session":
            if let raw = event.payload, raw["sessionId"]?.stringValue != nil { upsertPty(PtySession(raw: raw)) }
        case "pty:exit":
            guard let id = event.payload?["sessionId"]?.stringValue else { return }
            ptySessions.removeAll { $0.id == id }
            onChange?()
        case "pty:conversation", "pty:data":
            onPtyEvent?(event)
        default:
            break
        }
    }

    // MARK: file viewer fetch (round 4) — GET /fs/stat → /fs/read | /fs/image

    enum FileFetchResult: Sendable {
        case text(content: String, lines: Int)
        case image(Data)
        case tooLarge(size: Int)
        case binary(size: Int)
        case failure(String)
    }

    func fetchFile(path: String) async -> FileFetchResult {
        guard let connection, connected else { return .failure("Not connected") }
        // Stat preflight caps what rides the tunnel (5 MB envelope; /fs/read ships up to 8 MB JSON).
        let stat = try? await connection.sendControl(method: "GET",
            path: "/fs/stat?path=\(queryEscape(path))", bodyData: Data("{}".utf8))
        let size = stat?.body?["size"]?.intValue

        if FileViewer.isImagePath(path) {
            if let size, size > FileViewer.imageFetchCap { return .tooLarge(size: size) }
            do {
                let resp = try await connection.sendControlRaw(method: "GET",
                    path: "/fs/image?path=\(queryEscape(path))", bodyData: Data("{}".utf8))
                guard case .asset(let a) = resp, let data = Data(base64Encoded: a.bytesB64) else {
                    return .failure("Unexpected image response")
                }
                return .image(data)
            } catch { return .failure(fetchError(error)) }
        }

        if let size, size > FileViewer.textFetchCap { return .tooLarge(size: size) }
        do {
            let reply = try await connection.sendControl(method: "GET",
                path: "/fs/read?path=\(queryEscape(path))", bodyData: Data("{}".utf8))
            guard let body = reply.body, let payload = FileViewer.parseReadPayload(body) else {
                return .failure("Unexpected read response")
            }
            switch payload {
            case .text(let content, let lines): return .text(content: content, lines: lines)
            case .binary(let size):             return .binary(size: size)
            case .large(let size):              return .tooLarge(size: size)
            }
        } catch { return .failure(fetchError(error)) }
    }

    private func fetchError(_ error: Error) -> String {
        if case WSConnection.WSError.controlFailed(404) = error { return "File not found" }
        return error.localizedDescription
    }

    // Absolute paths ride the query string ("/Users/x/dev repo"); urlQueryAllowed keeps &/=/+, so
    // strip those too or a path containing them would split the params server-side.
    private func queryEscape(_ s: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=?+")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    // MARK: link lifecycle — commands forwarded to the supervisor

    func activate() {
        guard device.relayURL != nil else { setError("bad relay url"); return }
        link.activate()
    }

    // Drop the socket on background; foreground reconnects. Keeps caches + creds.
    func deactivate() { link.deactivate() }

    func networkAvailable() { link.networkAvailable() }

    func waitUntilSettled() async { await link.waitUntilSettled() }

    // Tear the socket down (device removed). Does NOT wipe creds — the caller (DeviceStore) owns
    // credential lifetime.
    func teardown() {
        link.deactivate()
        openId = nil; transcript = []
        onChange?()
    }

    // Once per live link, after the daemon's snapshot re-seeded workers/pending: fetch what the
    // snapshot doesn't carry. Rows that landed during the gap never re-announce, so the open
    // transcript is pulled explicitly.
    private func didGoLive() {
        controlError = nil
        eosLog.info("connect[\(self.deviceId, privacy: .public)]: live")
        Task {
            if !ptySubscription.isEmpty { await connection?.sendSubscription(pty: ptySubscription) }
            await fetchPtySessions()
            // C6: ui-config is fetched once per connect (covers reconnects too) and cached.
            await fetchUiConfig()
        }
        if openId != nil { scheduleDelta() }
    }

    private func setError(_ message: String) { controlError = message; onChange?() }

    // MARK: live transcript (ported verbatim, per-device)

    func openWorker(_ id: String) async {
        openId = id
        liveBuffers = [:]
        liveTerminals = [:]
        liveCheck = nil
        invalidateDurableBlocks()   // switching workers swaps durableEvs — drop the previous scan
        optimisticBubbles.removeAll { $0.workerId != id }
        if let c = caches[id] {
            durableEvs = c.durableEvs; durableBlockIds = c.durableBlockIds
            newestRowId = c.newestRowId; oldestRowId = c.oldestRowId; hasOlder = c.hasOlder
            recompute()   // immediate: cached-first paint on open, no debounce
            await fetchDelta()
        } else {
            durableEvs = [:]; durableBlockIds = []
            newestRowId = 0; oldestRowId = 0; hasOlder = false
            transcript = []
            onChange?()   // publish the switch now, not after the first page's round trip
            await fetchNewest()
        }
    }

    func closeWorker(_ id: String) {
        guard openId == id else { return }
        caches[id] = TranscriptCache(durableEvs: durableEvs, durableBlockIds: durableBlockIds,
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
        // A long gap can hold more than one page — keep paging until the tail is reached.
        while let rows = await fetchEvents("afterId=\(newestRowId)&limit=\(deltaPageSize)"), openId == id, !rows.isEmpty {
            ingest(rows, workerId: id)
            if rows.count < deltaPageSize { break }
        }
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
        pipeLog.info("ingest \(rows.count) rows for \(workerId, privacy: .public) (newest=\(self.newestRowId))")
        var changed = false
        for r in rows {
            guard let rid = r["id"]?.intValue else { continue }
            newestRowId = max(newestRowId, rid)
            oldestRowId = oldestRowId == 0 ? rid : min(oldestRowId, rid)
            durableEvs[String(rid)] = toEv(r)   // JSON-string decode happens ONCE, here
            changed = true
        }
        if changed { invalidateDurableBlocks() }
        scheduleRecompute()
    }

    // Durable-blocks memo: buildBlocks over the durable set is the expensive scan. Most live frames
    // (agent:delta, terminal:chunk) mutate ONLY the overlays, not durableEvs — so the durable blocks
    // are cached and reused, and recompute re-merges the cheap live overlays on top. Invalidated
    // whenever the durable set changes (ingest).
    private var durableBlocksCache: [Block]?
    private var durableBlockIdsCache: Set<String>?
    private func invalidateDurableBlocks() { durableBlocksCache = nil; durableBlockIdsCache = nil }

    // The set of blockIds carried by durable rows (used to drop live buffers whose durable canonical
    // block has landed). Reads the ALREADY-PARSED Ev payloads — no re-decode of the JSON string.
    private func computeDurableBlockIds() -> Set<String> {
        var ids: Set<String> = []
        for ev in durableEvs.values {
            let p = ev.payload
            if p["type"]?.stringValue == "message" {
                for b in p["blocks"]?.arrayValue ?? [] {
                    if let bid = b["blockId"]?.stringValue { ids.insert(bid) }
                }
            } else if let bid = p["blockId"]?.stringValue {
                ids.insert(bid)
            }
        }
        return ids
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
        scheduleRecompute()
    }

    // A snapshot is a resync point: deltas and terminal chunks streamed while the link was down are
    // lost, so the incremental overlays would show text with a hole. Restart them from the daemon's
    // in-flight text instead (older daemons send none, which just clears them).
    private func restartLiveOverlays(_ live: [LiveBlock]?) {
        liveBuffers = [:]
        liveTerminals = [:]
        let now = Date().timeIntervalSince1970 * 1000
        for block in live ?? [] where block.workerId == openId {
            liveBuffers[block.blockId] = LiveBuffer(blockId: block.blockId, channel: block.channel,
                                                    text: block.text, ts: now)
        }
        scheduleRecompute()
    }

    func handleTranscriptEvent(_ event: EventFrame) {
        if let ts = event.ts, ts > 0 {
            turnClock.sample(serverTsMs: ts, deviceNowMs: Date().timeIntervalSince1970 * 1000)
        }
        switch event.reason {
        case "agent:delta": applyDelta(event.payload)
        case "worker:change": if event.payload?["workerId"]?.stringValue == openId { scheduleDelta() }
        case "terminal:chunk": applyTerminalChunk(event.payload)
        case "terminal:done": applyTerminalDone(event.payload)
        case "loop:check": applyLoopCheck(event.payload)
        default: break
        }
    }

    // MARK: list-state liveness (worker states, pending asks)

    // Compat fallback for daemons that don't push §5.4.2 patches yet: change
    // events carry only ids, so refetch the list they refer to (debounced).
    // Stands down permanently once a patch/snapshot frame proves the daemon
    // pushes state (Store.serverPushesState).
    private var listRefreshScheduled = false
    private var pendingRefreshWanted = false

    func handleListEvent(_ event: EventFrame) async {
        guard !(await store.serverPushesState) else { return }
        switch event.reason {
        case "worker:change", "worker:spawn", "worker:exit", "worker:removed":
            scheduleListRefresh(includePending: false)
        case "pending:created", "pending:resolved", "pending:ttl_expired":
            scheduleListRefresh(includePending: true)
        default: break
        }
    }

    private func scheduleListRefresh(includePending: Bool) {
        if includePending { pendingRefreshWanted = true }
        guard !listRefreshScheduled else { return }
        listRefreshScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            listRefreshScheduled = false
            let wantPending = pendingRefreshWanted
            pendingRefreshWanted = false
            guard let connection, connected else { return }
            if let rows = (try? await connection.sendControl(method: "GET", path: "/workers",
                                                             bodyData: Data("{}".utf8)))?.body?.arrayValue {
                await store.applyWorkers(rows)
            }
            if wantPending,
               let rows = (try? await connection.sendControl(method: "GET", path: "/pending",
                                                             bodyData: Data("{}".utf8)))?.body?.arrayValue {
                await store.applyPending(rows)
            }
        }
    }

    // Seq-gap recovery (§5.2.2): frames were missed — ask for a fresh snapshot
    // and, with a conversation open, pull the transcript delta too. Rate-limited;
    // a pre-snapshot daemon ignores the hello and the fallback above still runs.
    private var lastHelloAt: Double = 0

    private func recoverFromGap() async {
        let now = Date().timeIntervalSince1970
        guard now - lastHelloAt > 5 else { return }
        lastHelloAt = now
        let cursor = await store.lastSeq
        await connection?.sendHello(lastContentId: cursor)
        if openId != nil { scheduleDelta() }
    }

    private func applyTerminalChunk(_ payload: JSONValue?) {
        guard let id = openId, payload?["workerId"]?.stringValue == id,
              let runId = payload?["runId"]?.stringValue else { return }
        var run = liveTerminals[runId] ?? LiveTerminal(runId: runId, command: "", output: "", done: false,
                                                       exitCode: 0, note: nil, ts: Date().timeIntervalSince1970 * 1000)
        if let cmd = payload?["command"]?.stringValue, !cmd.isEmpty { run.command = cmd }
        run.output += payload?["data"]?.stringValue ?? ""
        liveTerminals[runId] = run
        scheduleRecompute()
    }

    private func applyTerminalDone(_ payload: JSONValue?) {
        guard let runId = payload?["runId"]?.stringValue, var run = liveTerminals[runId] else { return }
        run.done = true
        run.exitCode = payload?["exitCode"]?.intValue ?? 0
        run.note = payload?["note"]?.stringValue
        liveTerminals[runId] = run
        scheduleRecompute()
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

    // Coalesce a burst of live frames into ONE recompute on the next runloop tick. A streaming turn
    // fires many agent:delta frames; without this each one drove a full recompute+publish. The tick
    // is sub-millisecond, so the tail still feels live — it just no longer reparses per frame.
    private func scheduleRecompute() {
        guard !recomputeScheduled else { return }
        recomputeScheduled = true
        Task { @MainActor in
            recomputeScheduled = false
            guard openId != nil else { return }
            recompute()
        }
    }

    private func recompute() {
        // Durable blocks + their blockIds are memoized; only a durableEvs change (ingest) invalidates
        // them. Overlay-only frames reuse the cached scan and just re-merge the cheap live overlays.
        let durableBlocks: [Block]
        if let cached = durableBlocksCache, let cachedIds = durableBlockIdsCache {
            durableBlocks = cached; durableBlockIds = cachedIds
        } else {
            durableBlockIds = computeDurableBlockIds()
            durableBlocks = MessageNormalizer.buildBlocks(evs: Array(durableEvs.values), workerId: openId ?? "")
            durableBlocksCache = durableBlocks; durableBlockIdsCache = durableBlockIds
        }
        // A durable block landing supersedes its live buffer (flicker-free handoff).
        for bid in durableBlockIds { liveBuffers[bid] = nil }
        var all = durableBlocks
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

// Link frames — fold this device's frames into ITS store, in arrival order.
extension DeviceConnection {
    fileprivate func handle(_ frame: ServerFrame) async {
        switch frame {
        case .snapshot(let snapshot):
            await store.applySnapshot(snapshot)
            restartLiveOverlays(snapshot.live)
        case .patch(let patch):
            if await store.applyPatch(patch) == .seqGap { await recoverFromGap() }
        case .event(let event):
            if await store.applyEvent(event) == .seqGap { await recoverFromGap() }
            handleTranscriptEvent(event)
            await handleListEvent(event)
            handlePtyEvent(event)
        case .error(let error):
            setError("\(error.code): \(error.message ?? "")")
        case .reply, .asset, .ka:
            break
        }
    }
}
