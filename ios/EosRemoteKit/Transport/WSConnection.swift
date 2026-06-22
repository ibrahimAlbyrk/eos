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

// The single WS actor (design §5.4): one URLSessionWebSocketTask, AEAD codec, control req/reply
// over a correlationId→continuation map with timeout, keepalive ping, backoff 1s→60s. Carries
// both directions; REST is tunneled as `control`.
public actor WSConnection {
    public enum WSError: Error { case notConnected, timeout, controlFailed(Int), badFrame }

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
    private var running = false

    public init(url: URL, mode: ConnectionMode, delegate: WSConnectionDelegate?) {
        self.url = url; self.mode = mode; self.delegate = delegate
    }

    public func attach(session: SessionState) { self.session = session }

    public func start() {
        running = true
        openSocket()
    }

    public func stop() {
        running = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failAllPending(WSError.notConnected)
    }

    private func openSocket() {
        var request = URLRequest(url: url)
        switch mode {
        case .lan(let spki):
            pinningDelegate = SPKIPinningDelegate(lanSpkiSHA256: spki)
        case .relay(let bearer):
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            pinningDelegate = nil
        }
        let cfg = URLSessionConfiguration.default
        let s = URLSession(configuration: cfg, delegate: pinningDelegate, delegateQueue: nil)
        urlSession = s
        let t = s.webSocketTask(with: request)
        task = t
        t.resume()
        Task { await self.onOpen() }
        receiveLoop()
        scheduleKeepalive()
    }

    private func onOpen() async {
        backoffMs = 1000
        await delegate?.wsConnectionStateChanged(connected: true)
    }

    // Backoff reconnect, ported from sse.js (1s, doubling, capped at 60s).
    private func scheduleReconnect() {
        guard running else { return }
        let delay = backoffMs
        backoffMs = min(backoffMs * 2, maxBackoffMs)
        Task {
            try? await Task.sleep(nanoseconds: delay * 1_000_000)
            guard self.running else { return }
            self.openSocket()
        }
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
            receiveLoop()
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
            // register/join/relayctl/ka/error are relay-control; the handshake driver consumes
            // join-ack out of band before the session is attached.
            break
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
        case .challenge(let c): await delegate?.wsDidReceive(challenge: c)
        case .error(let e):
            if let cid = e.correlationId, let cont = pending.removeValue(forKey: cid) {
                cont.resume(throwing: WSError.controlFailed(0))
            }
            await delegate?.wsDidReceive(error: e)
        case .ka: break
        }
    }

    // Tunneled REST: seal a control frame, await its reply by correlationId, with a timeout.
    public func sendControl(method: String, path: String, body: JSONValue,
                            stepUp: StepUpField? = nil, timeoutMs: UInt64 = 30_000) async throws -> ReplyFrame {
        guard let session, let task else { throw WSError.notConnected }
        let correlationId = UUID().uuidString
        let frame = ControlFrame(correlationId: correlationId, method: method, path: path, body: body, stepUp: stepUp)
        let plaintext = try JSONEncoder().encode(frame)
        let envelope = try session.sealOutgoing(plaintext)

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

    private func scheduleKeepalive() {
        Task { [weak self] in
            guard let self else { return }
            while await self.running {
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
