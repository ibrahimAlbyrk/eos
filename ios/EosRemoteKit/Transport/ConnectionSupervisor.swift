import Foundation
import OSLog

private let linkLog = Logger(subsystem: "dev.eos.remote", category: "connect")

// What the supervisor needs from one connection attempt. WSConnection is the real one; tests fake it.
public protocol RemoteLink: AnyObject, Sendable {
    // Every server frame that isn't a control reply, in order. Finishes when the link closes.
    var frames: AsyncStream<ServerFrame> { get }
    func join() async throws
    func sendHello(lastContentId: Int) async
    func probe(timeoutMs: UInt64) async -> Bool
    func close() async
}

public struct LinkTiming: Sendable {
    public var attemptTimeout: Double   // seconds for join + snapshot
    public var probeTimeout: Double
    public var backoff: [Double]        // retry delays in seconds; the last one repeats

    // Capped low: retries only run in the foreground, where a Mac waking up should show within seconds.
    public static let standard = LinkTiming(attemptTimeout: 20, probeTimeout: 4, backoff: [1, 2, 4, 8, 10])

    public init(attemptTimeout: Double, probeTimeout: Double, backoff: [Double]) {
        self.attemptTimeout = attemptTimeout; self.probeTimeout = probeTimeout; self.backoff = backoff
    }
}

// The one owner of a device's link lifecycle (§6): connect → join → hello/snapshot → live, and back
// to a retry whenever any step fails or the link dies.
//
// Every attempt gets a generation number. Anything that finishes after its attempt was replaced
// (a late join, a late close, a stale frame) sees a different generation and does nothing — that is
// what makes rapid background/foreground and network flaps safe. The join ack only proves the relay
// is there; the link counts as live once the daemon's snapshot arrives, which proves the Mac end too
// and re-seeds state in the same step.
@MainActor
public final class ConnectionSupervisor<Link: RemoteLink> {
    public enum State: Equatable, Sendable {
        case idle           // backgrounded or stopped: no socket, no retries
        case connecting     // socket + relay join in flight
        case syncing        // joined; waiting for the daemon's snapshot
        case live
        case waiting        // failed; a retry is scheduled
        case authRejected   // the relay refused the bearer — only re-pairing helps
    }

    public private(set) var state: State = .idle
    public private(set) var lastError: String?
    public private(set) var link: Link?
    // Controls go out only over a link the daemon has answered on.
    public var liveLink: Link? { state == .live ? link : nil }

    public var onChange: (@MainActor () -> Void)?
    // Frames are handed over one at a time, in order; the snapshot that makes the link live is
    // applied before `onLive` runs.
    public var onFrame: (@MainActor (ServerFrame) async -> Void)?
    public var onLive: (@MainActor () -> Void)?
    public var resumeCursor: @MainActor () async -> Int = { 0 }

    private let makeLink: @MainActor () -> Link
    private let timing: LinkTiming
    private var foreground = false
    private var generation = 0
    private var failures = 0
    private var attemptTasks: [Task<Void, Never>] = []
    private var settleWaiters: [CheckedContinuation<Void, Never>] = []

    public init(timing: LinkTiming = .standard, makeLink: @escaping @MainActor () -> Link) {
        self.timing = timing
        self.makeLink = makeLink
    }

    // MARK: commands — all synchronous, so their order is the caller's order

    // App is in the foreground: make sure the link is live, or on its way there.
    public func activate() {
        foreground = true
        switch state {
        case .live: probe()
        case .connecting, .syncing: break
        case .idle, .waiting, .authRejected:
            failures = 0
            connect()
        }
    }

    // App went to the background (or the device was removed): drop the link and stop retrying.
    public func deactivate() {
        foreground = false
        reset()
        set(.idle)
    }

    // The network came back or changed interface: retry now instead of waiting out the backoff, and
    // make sure a live socket survived the switch.
    public func networkAvailable() {
        guard foreground else { return }
        switch state {
        case .waiting: connect()
        case .live: probe()
        default: break
        }
    }

    // Suspends until the current attempt went live or failed (pairing waits on the first outcome).
    public func waitUntilSettled() async {
        guard state == .connecting || state == .syncing else { return }
        await withCheckedContinuation { settleWaiters.append($0) }
    }

    // MARK: attempt

    private func connect() {
        reset()
        let gen = generation
        let link = makeLink()
        self.link = link
        set(.connecting)
        let deadline = timing.attemptTimeout
        attemptTasks.append(Task { [weak self] in
            try? await Task.sleep(for: .seconds(deadline))
            guard let self, !Task.isCancelled, self.state != .live else { return }
            self.fail(gen, "Timed out connecting to the relay.")
        })
        attemptTasks.append(Task { [weak self] in await self?.run(link, gen) })
    }

    private func run(_ link: Link, _ gen: Int) async {
        do {
            try await link.join()
        } catch {
            fail(gen, Self.describe(error), auth: Self.isAuthRejected(error))
            return
        }
        guard gen == generation else { return }
        set(.syncing)
        attemptTasks.append(Task { [weak self] in
            for await frame in link.frames {
                guard let self, gen == self.generation else { return }
                await self.onFrame?(frame)
                guard gen == self.generation else { return }
                if self.state == .syncing, case .snapshot = frame { self.becomeLive() }
            }
            self?.fail(gen, "Connection lost.")
        })
        await link.sendHello(lastContentId: await resumeCursor())
    }

    private func becomeLive() {
        failures = 0
        lastError = nil
        linkLog.info("link live")
        set(.live)
        onLive?()
    }

    private func probe() {
        guard let link else { return }
        let gen = generation
        let timeoutMs = UInt64(timing.probeTimeout * 1000)
        attemptTasks.append(Task { [weak self] in
            guard await !link.probe(timeoutMs: timeoutMs) else { return }
            self?.fail(gen, "The relay stopped answering.")
        })
    }

    private func fail(_ gen: Int, _ reason: String, auth: Bool = false) {
        guard gen == generation else { return }
        linkLog.error("link failed: \(reason, privacy: .public)")
        reset()
        lastError = reason
        if auth { set(.authRejected); return }
        guard foreground else { set(.idle); return }
        let delay = timing.backoff[min(failures, timing.backoff.count - 1)] * Double.random(in: 0.8...1.2)
        failures += 1
        let retryGen = generation
        set(.waiting)
        attemptTasks.append(Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, retryGen == self.generation else { return }
            self.connect()
        })
    }

    // Invalidate the current attempt: bump the generation so nothing in flight can act on it later,
    // cancel its timers and loops, and close its socket.
    private func reset() {
        generation += 1
        for task in attemptTasks { task.cancel() }
        attemptTasks.removeAll()
        if let link { Task { await link.close() } }
        link = nil
    }

    private func set(_ newState: State) {
        state = newState
        if newState != .connecting && newState != .syncing {
            let waiters = settleWaiters
            settleWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
        onChange?()
    }

    private static func isAuthRejected(_ error: Error) -> Bool {
        if case Connector.ConnectError.authRejected = error { return true }
        return false
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case Connector.ConnectError.authRejected:
            return "This device is no longer paired. Pair it again."
        case Connector.ConnectError.transient(let detail) where detail.contains("ROOM_NOT_FOUND"):
            return "The Mac isn't connected to the relay (asleep or Eos not running)."
        case Connector.ConnectError.transient(let detail):
            return "Couldn't connect: \(detail)"
        default:
            return "Couldn't connect: \(error.localizedDescription)"
        }
    }
}
