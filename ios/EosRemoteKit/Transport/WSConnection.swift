import Foundation

// Incoming server frames the connection can't answer itself (control replies are handled inline).
public protocol WSConnectionDelegate: AnyObject, Sendable {
    func wsDidReceive(snapshot: SnapshotFrame) async
    func wsDidReceive(patch: PatchFrame) async
    func wsDidReceive(event: EventFrame) async
    func wsDidReceive(challenge: ChallengeFrame) async
    func wsDidReceive(error: ErrorFrame) async
    func wsConnectionStateChanged(connected: Bool) async
}

public enum ConnectionMode: Sendable {
    case lan(spkiSHA256: Data)   // wss://<mac>:7400/ws, SPKI-pinned
    case relay(bearer: String)   // wss://relay/ws, public-CA TLS + Bearer header
}

// The single WS actor (design §5.4). Two phases share one socket:
//   1. HANDSHAKE — manual, sequential send/receive of RAW envelopes (join, cleartext hs frames).
//   2. LIVE — after attach(session:)+beginLiveLoop(): AEAD codec, control req/reply over a
//      correlationId→continuation map with timeout, keepalive, backoff 1s→60s, event push.
public actor WSConnection {
    public enum WSError: Error { case notConnected, timeout, controlFailed(Int), badFrame, closed }

    private let url: URL
    private let mode: ConnectionMode
    private weak var delegate: WSConnectionDelegate?
    private var session: SessionState?

    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var pinningDelegate: SPKIPinningDelegate?

    private var pending: [String: CheckedContinuation<ReplyFrame, Error>] = [:]
    private var backoffMs: UInt64 = 1000
    private let maxBackoffMs: UInt64 = 60_000
    private let keepaliveMs: UInt64 = 20_000
    private var liveLoopRunning = false

    public init(url: URL, mode: ConnectionMode, delegate: WSConnectionDelegate?) {
        self.url = url; self.mode = mode; self.delegate = delegate
    }

    // MARK: phase 1 — handshake (manual, sequential)

    // Open the socket for the handshake. Does NOT start the auto receive-loop; the coordinator
    // drives send/receive sequentially during the cold handshake (join → PAIR-1/2/3 → welcome).
    public func openForHandshake() {
        var request = URLRequest(url: url)
        switch mode {
        case .lan(let spki): pinningDelegate = SPKIPinningDelegate(lanSpkiSHA256: spki)
        case .relay(let bearer):
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            pinningDelegate = nil
        }
        let s = URLSession(configuration: .default, delegate: pinningDelegate, delegateQueue: nil)
        urlSession = s
        let t = s.webSocketTask(with: request)
        task = t
        t.resume()
    }

    public func sendEnvelopeRaw(_ env: Envelope) async throws {
        guard let task else { throw WSError.notConnected }
        try await task.send(.data(env.encode()))
    }

    // Await exactly one inbound binary envelope (used only during the handshake phase).
    public func receiveEnvelopeRaw() async throws -> Envelope {
        guard let task else { throw WSError.notConnected }
        let message = try await task.receive()
        guard case .data(let data) = message else { throw WSError.badFrame }
        return try Envelope.decode(data)
    }

    // MARK: phase 2 — live

    public func attach(session: SessionState) { self.session = session }

    // Start the live receive-loop + keepalive once a session is attached. From here on, inbound
    // sealed `data` envelopes are opened and dispatched; control replies resolve their waiters.
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
            guard let session, session.acceptRxSeq(env.seq),
                  let plaintext = try? session.openIncoming(env),
                  let frame = try? ServerFrame.decode(plaintext) else { return }
            await dispatch(frame)
        default:
            break // relay-control frames are consumed by the handshake coordinator, not here
        }
    }

    private func dispatch(_ frame: ServerFrame) async {
        switch frame {
        case .reply(let r):
            if let cont = pending.removeValue(forKey: r.correlationId) {
                if (200..<300).contains(r.status) { cont.resume(returning: r) }
                else { cont.resume(throwing: WSError.controlFailed(r.status)) }
            }
        case .snapshot(let s): await delegate?.wsDidReceive(snapshot: s)
        case .patch(let p): await delegate?.wsDidReceive(patch: p)
        case .event(let e): await delegate?.wsDidReceive(event: e)
        case .challenge(let c):
            // POST /stepup/challenge replies with a `challenge` frame carrying the correlationId of
            // the awaiting control — adapt it into the ReplyFrame the caller expects (nonce in body).
            if let cid = c.correlationId, let cont = pending.removeValue(forKey: cid) {
                cont.resume(returning: ReplyFrame(t: "reply", correlationId: cid, status: 200,
                    body: .object(["challengeNonce": .string(c.challengeNonce),
                                   "expiresAt": .number(c.expiresAt)])))
            } else {
                await delegate?.wsDidReceive(challenge: c)
            }
        case .error(let e):
            if let cid = e.correlationId, let cont = pending.removeValue(forKey: cid) {
                cont.resume(throwing: WSError.controlFailed(0))
            }
            await delegate?.wsDidReceive(error: e)
        case .ka: break
        }
    }

    // Tunneled REST. `bodyData` is the body serialized EXACTLY ONCE (§3.4); it is carried as the
    // opaque `body` string and is the same bytes the caller hashed for any step-up signature.
    public func sendControl(method: String, path: String, bodyData: Data,
                            stepUp: StepUpField? = nil, timeoutMs: UInt64 = 30_000) async throws -> ReplyFrame {
        guard let session, let task else { throw WSError.notConnected }
        let correlationId = UUID().uuidString
        let bodyStr = String(decoding: bodyData, as: UTF8.self)
        let frame = ControlFrame(correlationId: correlationId, method: method, path: path, body: bodyStr, stepUp: stepUp)
        let envelope = try session.sealOutgoing(try JSONEncoder().encode(frame))

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
            // Reconnect re-runs the handshake/resume from the owner; here we just surface the drop.
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
        guard let plaintext = try? JSONEncoder().encode(ka),
              let env = try? session.sealOutgoing(plaintext) else { return }
        task.send(.data(env)) { _ in }
    }
}
