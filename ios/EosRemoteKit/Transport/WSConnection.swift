import Foundation
import OSLog

// Frame-level wire diagnostics (Console.app: subsystem dev.eos.remote, category frames).
private let frameLog = Logger(subsystem: "dev.eos.remote", category: "frames")
private struct TagPeek: Decodable { let t: String }

// Incoming server frames the connection can't answer itself (control replies are handled inline).
public protocol WSConnectionDelegate: AnyObject, Sendable {
    func wsDidReceive(snapshot: SnapshotFrame) async
    func wsDidReceive(patch: PatchFrame) async
    func wsDidReceive(event: EventFrame) async
    func wsDidReceive(error: ErrorFrame) async
    func wsConnectionStateChanged(connected: Bool) async
}

// The single WS actor (§5, §6). Two phases share one socket:
//   1. JOIN — manual, sequential send/receive of RAW envelopes (relay join → joined ack).
//   2. LIVE — after attach(session:)+beginLiveLoop(): plaintext `data` framing, control req/reply
//      over a correlationId→continuation map with timeout, keepalive, backoff 1s→60s, event push.
// Relay TLS is public-CA (no SPKI pinning); the bearer rides the join frame, not an HTTP header.
public actor WSConnection {
    public enum WSError: Error { case notConnected, timeout, controlFailed(Int), badFrame, closed }

    private let url: URL
    private weak var delegate: WSConnectionDelegate?
    private var session: SessionState?

    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?

    private var pending: [String: CheckedContinuation<ReplyFrame, Error>] = [:]
    private var backoffMs: UInt64 = 1000
    private let maxBackoffMs: UInt64 = 60_000
    private let keepaliveMs: UInt64 = 20_000
    private var liveLoopRunning = false

    public init(url: URL, delegate: WSConnectionDelegate?) {
        self.url = url; self.delegate = delegate
    }

    // MARK: phase 1 — join (manual, sequential)

    // Open the socket for the join. Does NOT start the auto receive-loop; the connector drives
    // send/receive sequentially during the cold join (join → joined ack).
    public func openForJoin() {
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

    // Await exactly one inbound binary envelope (used only during the join phase). Bounded by a
    // timeout so a silent relay (daemon offline / room gone) converts to a throw the caller treats
    // as transient → bounded backoff → eventual re-pair, never an infinite wait on "connecting".
    public func receiveEnvelopeRaw(timeoutMs: UInt64 = 15_000) async throws -> Envelope {
        guard let task else { throw WSError.notConnected }
        return try await withThrowingTaskGroup(of: Envelope.self) { group in
            group.addTask {
                let message = try await task.receive()
                guard case .data(let data) = message else { throw WSError.badFrame }
                return try Envelope.decode(data)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
                throw WSError.timeout
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw WSError.timeout }
            return first
        }
    }

    // MARK: phase 2 — live

    public func attach(session: SessionState) { self.session = session }

    // Start the live receive-loop + keepalive once a session is attached. From here on, inbound
    // `data` envelopes are decoded as plaintext inner frames and dispatched; control replies resolve
    // their waiters.
    public func beginLiveLoop() {
        guard !liveLoopRunning else { return }
        liveLoopRunning = true
        Task { await delegate?.wsConnectionStateChanged(connected: true) }
        receiveLoop()
        scheduleKeepalive()
    }

    public func stop() {
        liveLoopRunning = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failAllPending(WSError.closed)
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { await self.handleReceive(result) }
        }
    }

    private func handleReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) async {
        switch result {
        case .failure:
            await delegate?.wsConnectionStateChanged(connected: false)
            task = nil
            scheduleReconnect()
        case .success(let message):
            if case .data(let data) = message { await routeEnvelope(data) }
            if liveLoopRunning { receiveLoop() }
        }
    }

    private func routeEnvelope(_ data: Data) async {
        guard let env = try? Envelope.decode(data) else { return }
        switch env.type {
        case .data:
            guard let session else { frameLog.error("data frame before session attach — dropped"); return }
            guard let frame = try? ServerFrame.decode(session.envelopeToJSON(env)) else {
                // Tag + size only — payloads can embed transcript text.
                let tag = (try? JSONDecoder().decode(TagPeek.self, from: env.payload))?.t ?? "?"
                frameLog.error("undecodable inner frame — dropped (t=\(tag, privacy: .public), \(env.payload.count) bytes)")
                return
            }
            await dispatch(frame)
        default:
            break // relay-control frames are consumed by the join coordinator, not here
        }
    }

    private func dispatch(_ frame: ServerFrame) async {
        switch frame {
        case .reply(let r):
            if let cont = pending.removeValue(forKey: r.correlationId) {
                if (200..<300).contains(r.status) { cont.resume(returning: r) }
                else { cont.resume(throwing: WSError.controlFailed(r.status)) }
            }
        case .snapshot(let s):
            frameLog.info("rx snapshot seq=\(s.seq) workers=\(s.workers.count)")
            await delegate?.wsDidReceive(snapshot: s)
        case .patch(let p):
            frameLog.info("rx patch seq=\(p.seq) \(p.resource, privacy: .public)/\(p.op, privacy: .public)")
            await delegate?.wsDidReceive(patch: p)
        case .event(let e):
            frameLog.info("rx event seq=\(e.seq) \(e.reason, privacy: .public)")
            await delegate?.wsDidReceive(event: e)
        case .error(let e):
            if let cid = e.correlationId, let cont = pending.removeValue(forKey: cid) {
                cont.resume(throwing: WSError.controlFailed(0))
            }
            await delegate?.wsDidReceive(error: e)
        case .ka: break
        }
    }

    // Tunneled REST. `bodyData` is the body serialized EXACTLY ONCE (§5.2.3); it is carried verbatim
    // as the opaque `body` string.
    public func sendControl(method: String, path: String, bodyData: Data,
                            timeoutMs: UInt64 = 30_000) async throws -> ReplyFrame {
        guard let session, let task else { throw WSError.notConnected }
        let correlationId = UUID().uuidString
        let bodyStr = String(decoding: bodyData, as: UTF8.self)
        let frame = ControlFrame(correlationId: correlationId, method: method, path: path, body: bodyStr)
        let envelope = session.frameToEnvelope(try JSONEncoder().encode(frame))

        let timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            await self?.timeout(correlationId)
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

    private func timeout(_ correlationId: String) {
        if let cont = pending.removeValue(forKey: correlationId) { cont.resume(throwing: WSError.timeout) }
    }
    private func fail(_ correlationId: String, _ error: Error) {
        if let cont = pending.removeValue(forKey: correlationId) { cont.resume(throwing: error) }
    }
    private func failAllPending(_ error: Error) {
        for (_, cont) in pending { cont.resume(throwing: error) }
        pending.removeAll()
    }

    private func scheduleReconnect() {
        guard liveLoopRunning else { return }
        let delay = backoffMs
        backoffMs = min(backoffMs * 2, maxBackoffMs)
        Task {
            try? await Task.sleep(nanoseconds: delay * 1_000_000)
            // Reconnect re-runs the join/resume from the owner; here we just surface the drop.
        }
    }

    private func scheduleKeepalive() {
        Task { [weak self] in
            guard let self else { return }
            while await self.liveLoopRunning {
                try? await Task.sleep(nanoseconds: self.keepaliveMs * 1_000_000)
                await self.sendKeepalive()
            }
        }
    }

    private func sendKeepalive() async {
        guard let session, let task else { return }
        let ka = KaFrame(t: "ka", ts: 0)
        guard let json = try? JSONEncoder().encode(ka) else { return }
        task.send(.data(session.frameToEnvelope(json))) { _ in }
    }

    // §5.2.2 resume hint / §5.4.3 snapshot request. Fire-and-forget: the daemon
    // answers with a `snapshot` frame on the normal push path (no correlation).
    public func sendHello(lastContentId: Int) {
        guard let session, let task else { return }
        var hello = HelloFrame()
        hello.lastContentId = lastContentId
        guard let json = try? JSONEncoder().encode(hello) else { return }
        task.send(.data(session.frameToEnvelope(json))) { _ in }
    }
}
