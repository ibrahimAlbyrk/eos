import Foundation
import OSLog

// Frame-level wire diagnostics (Console.app: subsystem dev.eos.remote, category frames).
private let frameLog = Logger(subsystem: "dev.eos.remote", category: "frames")
private struct TagPeek: Decodable { let t: String }

// One relay socket, from open to close (§5, §6). It never reconnects itself: ConnectionSupervisor owns
// the retry policy and builds a fresh WSConnection per attempt, so nothing from a dead socket can leak
// into the next one. Two phases share the socket:
//   1. JOIN — manual, sequential send/receive of RAW envelopes (relay join → joined ack).
//   2. LIVE — plaintext `data` framing. Control replies resolve their waiters; every other server frame
//      is yielded on `frames`, which finishes exactly once, when the socket closes for any reason.
// A ping heartbeat closes the socket when the relay stops answering — iOS keeps reporting a socket
// open long after a network switch or a suspension has killed it.
// Relay TLS is public-CA (no SPKI pinning); the bearer rides the join frame, not an HTTP header.
public actor WSConnection: RemoteLink {
    public enum WSError: Error { case notConnected, timeout, controlFailed(Int), badFrame, closed }

    // A control's answer: JSON routes resolve as `reply`; binary asset routes (/fs/image, /fs/raw)
    // resolve as the out-of-band base64 `asset` frame (§5.4.5).
    public enum ControlResponse: Sendable {
        case reply(ReplyFrame)
        case asset(AssetFrame)
    }

    public nonisolated let frames: AsyncStream<ServerFrame>
    private let framesContinuation: AsyncStream<ServerFrame>.Continuation

    private let url: URL
    private let room: String
    private let bearer: String
    private var session: SessionState?

    private var urlSession: URLSession?
    private var task: URLSessionWebSocketTask?
    private var closed = false

    private var pending: [String: CheckedContinuation<ControlResponse, Error>] = [:]
    private var pings: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private var heartbeat: Task<Void, Never>?
    private let heartbeatMs: UInt64 = 15_000
    private let pingTimeoutMs: UInt64 = 10_000

    public init(url: URL, room: String, bearer: String) {
        self.url = url; self.room = room; self.bearer = bearer
        (frames, framesContinuation) = AsyncStream.makeStream(of: ServerFrame.self)
    }

    // Open + relay join + go live. No timeout of its own: URLSession's receive() ignores task
    // cancellation, so the only thing that unblocks a silent join is close() — the supervisor's
    // attempt deadline does exactly that.
    public func join() async throws {
        _ = try await Connector(connection: self, room: room, bearer: bearer).run()
    }

    // MARK: phase 1 — join (manual, sequential)

    // Open the socket for the join. Does NOT start the receive loop; the connector drives
    // send/receive sequentially during the join (join → joined ack).
    public func openForJoin() {
        guard !closed else { return }
        let s = URLSession(configuration: .default)
        urlSession = s
        let t = s.webSocketTask(with: URLRequest(url: url))
        task = t
        t.resume()
    }

    public func sendEnvelopeRaw(_ env: Envelope) async throws {
        guard let task else { throw WSError.notConnected }
        try await task.send(.data(env.encode()))
    }

    // Await exactly one inbound binary envelope (used only during the join phase).
    public func receiveEnvelopeRaw() async throws -> Envelope {
        guard let task else { throw WSError.notConnected }
        guard case .data(let data) = try await task.receive() else { throw WSError.badFrame }
        return try Envelope.decode(data)
    }

    // MARK: phase 2 — live

    public func attach(session: SessionState) { self.session = session }

    // Start the live receive loop + heartbeat once a session is attached.
    public func beginLiveLoop() {
        guard !closed, heartbeat == nil else { return }
        receiveNext()
        let interval = heartbeatMs
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: interval * 1_000_000)
                guard let self, !Task.isCancelled else { return }
                await self.beat()
            }
        }
    }

    // Idempotent. Fails every waiter and finishes `frames`, so the owner learns about the close from
    // one place no matter who initiated it.
    public func close() {
        guard !closed else { return }
        closed = true
        heartbeat?.cancel(); heartbeat = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        urlSession?.invalidateAndCancel(); urlSession = nil
        for (_, cont) in pending { cont.resume(throwing: WSError.closed) }
        pending.removeAll()
        for (_, cont) in pings { cont.resume(returning: false) }
        pings.removeAll()
        framesContinuation.finish()
    }

    // A WebSocket ping the relay must answer (its ws server pongs automatically).
    public func probe(timeoutMs: UInt64) async -> Bool {
        guard !closed, let task else { return false }
        let id = UUID()
        return await withCheckedContinuation { cont in
            pings[id] = cont
            task.sendPing { [weak self] error in
                Task { await self?.settlePing(id, alive: error == nil) }
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
                await self?.settlePing(id, alive: false)
            }
        }
    }

    private func settlePing(_ id: UUID, alive: Bool) {
        pings.removeValue(forKey: id)?.resume(returning: alive)
    }

    // The ka keeps the daemon's idle sweep from pruning this session; the ping proves the socket.
    private func beat() async {
        sendFrame(KaFrame(t: "ka", ts: 0))
        if await !probe(timeoutMs: pingTimeoutMs) {
            frameLog.error("heartbeat: no pong — closing")
            close()
        }
    }

    private func receiveNext() {
        guard !closed, let task else { return }
        task.receive { [weak self] result in
            Task { await self?.handleReceive(result) }
        }
    }

    private func handleReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        guard !closed else { return }
        switch result {
        case .failure(let error):
            frameLog.info("socket closed: \(error.localizedDescription, privacy: .public)")
            close()
        case .success(let message):
            if case .data(let data) = message { routeEnvelope(data) }
            receiveNext()
        }
    }

    private func routeEnvelope(_ data: Data) {
        // Relay-control frames only matter during the join, which reads them directly.
        guard let env = try? Envelope.decode(data), env.type == .data else { return }
        guard let session else { frameLog.error("data frame before session attach — dropped"); return }
        guard let frame = try? ServerFrame.decode(session.envelopeToJSON(env)) else {
            // Tag + size only — payloads can embed transcript text.
            let tag = (try? JSONDecoder().decode(TagPeek.self, from: env.payload))?.t ?? "?"
            frameLog.error("undecodable inner frame — dropped (t=\(tag, privacy: .public), \(env.payload.count) bytes)")
            return
        }
        switch frame {
        case .reply(let r):
            resolve(r.correlationId, status: r.status, .reply(r))
        case .asset(let a):
            resolve(a.correlationId, status: a.status, .asset(a))
        case .error(let e):
            if let cid = e.correlationId, let cont = pending.removeValue(forKey: cid) {
                cont.resume(throwing: WSError.controlFailed(0))
            }
            framesContinuation.yield(frame)
        case .snapshot(let s):
            frameLog.info("rx snapshot seq=\(s.seq) workers=\(s.workers.count)")
            framesContinuation.yield(frame)
        case .patch(let p):
            frameLog.info("rx patch seq=\(p.seq) \(p.resource, privacy: .public)/\(p.op, privacy: .public)")
            framesContinuation.yield(frame)
        case .event(let e):
            frameLog.info("rx event seq=\(e.seq) \(e.reason, privacy: .public)")
            framesContinuation.yield(frame)
        case .rows(let r):
            frameLog.info("rx rows \(r.rows.count) for \(r.workerId, privacy: .public)")
            framesContinuation.yield(frame)
        case .ka:
            break
        }
    }

    private func resolve(_ correlationId: String, status: Int, _ response: ControlResponse) {
        guard let cont = pending.removeValue(forKey: correlationId) else { return }
        if (200..<300).contains(status) { cont.resume(returning: response) }
        else { cont.resume(throwing: WSError.controlFailed(status)) }
    }

    // Tunneled REST. `bodyData` is the body serialized EXACTLY ONCE (§5.2.3); it is carried verbatim
    // as the opaque `body` string. JSON routes only — an asset answer is a badFrame here.
    public func sendControl(method: String, path: String, bodyData: Data,
                            timeoutMs: UInt64 = 30_000) async throws -> ReplyFrame {
        guard case .reply(let r) = try await sendControlRaw(method: method, path: path,
                                                            bodyData: bodyData, timeoutMs: timeoutMs)
        else { throw WSError.badFrame }
        return r
    }

    // Variant for routes that may answer with a binary `asset` frame (/fs/image).
    public func sendControlRaw(method: String, path: String, bodyData: Data,
                               timeoutMs: UInt64 = 30_000) async throws -> ControlResponse {
        guard !closed, let session, let task else { throw WSError.notConnected }
        let correlationId = UUID().uuidString
        let bodyStr = String(decoding: bodyData, as: UTF8.self)
        let frame = ControlFrame(correlationId: correlationId, method: method, path: path, body: bodyStr)
        let envelope = session.frameToEnvelope(try JSONEncoder().encode(frame))

        let timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            await self?.fail(correlationId, WSError.timeout)
        }
        defer { timeoutTask.cancel() }

        return try await withCheckedThrowingContinuation { cont in
            pending[correlationId] = cont
            task.send(.data(envelope)) { [weak self] err in
                guard let self else { return }
                if let err { Task { await self.fail(correlationId, err) } }
            }
        }
    }

    // Tunneled REST without waiting for the answer (keystrokes): calls made one after another go out
    // in that order, and the Mac writes terminal input in arrival order. The reply is dropped.
    public func sendControlNoReply(method: String, path: String, bodyData: Data) throws {
        guard !closed, let session, let task else { throw WSError.notConnected }
        let frame = ControlFrame(correlationId: UUID().uuidString, method: method, path: path,
                                 body: String(decoding: bodyData, as: UTF8.self))
        task.send(.data(session.frameToEnvelope(try JSONEncoder().encode(frame)))) { _ in }
    }

    private func fail(_ correlationId: String, _ error: Error) {
        pending.removeValue(forKey: correlationId)?.resume(throwing: error)
    }

    // §5.2.2 resume hint / §5.4.3 snapshot request. Fire-and-forget: the daemon
    // answers with a `snapshot` frame on the normal push path (no correlation).
    public func sendHello(lastContentId: Int) {
        var hello = HelloFrame()
        hello.lastContentId = lastContentId
        sendFrame(hello)
    }

    // Replace the set of PTY sessions whose pty:data this device receives. Fire-and-forget; the
    // daemon forgets it with the socket, so the owner re-sends it after every reconnect.
    public func sendSubscription(pty ids: [String]) {
        sendFrame(SubFrame(pty: ids))
    }

    // What this phone shows for the Mac (Mac cap "focus"). Fire-and-forget; the Mac forgets it with
    // the socket, so the owner re-sends it after every reconnect.
    public func sendFocus(_ focus: FocusFrame) {
        sendFrame(focus)
    }

    private func sendFrame<F: Encodable>(_ frame: F) {
        guard !closed, let session, let task, let json = try? JSONEncoder().encode(frame) else { return }
        task.send(.data(session.frameToEnvelope(json))) { _ in }
    }
}
