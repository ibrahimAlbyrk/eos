import XCTest
@testable import EosRemoteKit

// A scripted link: how its join ends, whether the daemon answers hello, whether pings come back.
private actor FakeLink: RemoteLink {
    enum Join: Sendable { case ok, fail(Connector.ConnectError), hang }

    nonisolated let frames: AsyncStream<ServerFrame>
    private let continuation: AsyncStream<ServerFrame>.Continuation
    private let joinBehavior: Join
    private let answersHello: Bool
    private let probeAlive: Bool
    private var hung: CheckedContinuation<Void, Never>?
    private(set) var closed = false

    init(join: Join, answersHello: Bool, probeAlive: Bool) {
        joinBehavior = join; self.answersHello = answersHello; self.probeAlive = probeAlive
        (frames, continuation) = AsyncStream.makeStream(of: ServerFrame.self)
    }

    func join() async throws {
        switch joinBehavior {
        case .ok: return
        case .fail(let error): throw error
        case .hang:
            await withCheckedContinuation { hung = $0 }
            throw WSConnection.WSError.closed
        }
    }

    func sendHello(lastContentId: Int) {
        guard answersHello else { return }
        continuation.yield(.snapshot(SnapshotFrame(t: "snapshot", seq: 1, workers: [], pending: [])))
    }

    func probe(timeoutMs: UInt64) -> Bool { probeAlive && !closed }

    func close() {
        closed = true
        continuation.finish()
        hung?.resume(); hung = nil
    }

    // The socket died underneath us.
    func drop() { continuation.finish() }
}

@MainActor
final class ConnectionSupervisorTests: XCTestCase {
    private struct Script { var join: FakeLink.Join = .ok; var answersHello = true; var probeAlive = true }

    private var scripts: [Script] = []
    private var links: [FakeLink] = []

    private func makeSupervisor(_ scripts: [Script], backoff: [Double] = [0.02]) -> ConnectionSupervisor<FakeLink> {
        self.scripts = scripts
        links = []
        let timing = LinkTiming(attemptTimeout: 0.3, probeTimeout: 0.1, backoff: backoff)
        return ConnectionSupervisor(timing: timing) { [unowned self] in
            let s = self.scripts.isEmpty ? Script() : self.scripts.removeFirst()
            let link = FakeLink(join: s.join, answersHello: s.answersHello, probeAlive: s.probeAlive)
            self.links.append(link)
            return link
        }
    }

    private func until(_ what: String, timeout: Double = 2, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("timed out waiting for \(what)"); return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func testGoesLiveOnlyAfterTheDaemonSnapshot() async {
        let sup = makeSupervisor([Script()])
        var liveCount = 0
        sup.onLive = { liveCount += 1 }
        sup.activate()
        XCTAssertEqual(sup.state, .connecting)
        XCTAssertNil(sup.liveLink, "no controls before the daemon answered")
        await until("live") { sup.state == .live }
        XCTAssertNotNil(sup.liveLink)
        XCTAssertEqual(liveCount, 1)
        XCTAssertEqual(links.count, 1)
    }

    func testJoinWithoutSnapshotHitsTheDeadlineAndRetries() async {
        let sup = makeSupervisor([Script(answersHello: false), Script()])
        sup.activate()
        await until("live on the second link") { sup.state == .live }
        XCTAssertEqual(links.count, 2)
        let firstClosed = await links[0].closed
        XCTAssertTrue(firstClosed, "the silent link must be closed, not leaked")
    }

    func testTransientFailureRetries() async {
        let sup = makeSupervisor([Script(join: .fail(.transient("relay ROOM_NOT_FOUND"))), Script()])
        sup.activate()
        await until("waiting") { sup.state == .waiting || sup.state == .live }
        await until("live") { sup.state == .live }
        XCTAssertEqual(links.count, 2)
        XCTAssertNil(sup.lastError, "going live clears the failure")
    }

    func testRetriesNeverGiveUpInTheForeground() async {
        let failing = Array(repeating: Script(join: .fail(.transient("down"))), count: 10)
        let sup = makeSupervisor(failing + [Script()], backoff: [0.005])
        sup.activate()
        await until("live after 10 failures") { sup.state == .live }
        XCTAssertEqual(links.count, 11)
    }

    func testAuthRejectedStopsRetrying() async {
        let sup = makeSupervisor([Script(join: .fail(.authRejected))])
        sup.activate()
        await until("authRejected") { sup.state == .authRejected }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(links.count, 1)
        XCTAssertNotNil(sup.lastError)
    }

    func testBackgroundDuringJoinIsFinal() async {
        let sup = makeSupervisor([Script(join: .hang)])
        sup.activate()
        await until("join started") { links.count == 1 }
        sup.deactivate()
        XCTAssertEqual(sup.state, .idle)
        try? await Task.sleep(nanoseconds: 400_000_000)   // past the attempt deadline
        XCTAssertEqual(sup.state, .idle, "a join finishing after background must not revive the link")
        XCTAssertEqual(links.count, 1, "no retries while backgrounded")
        let closed = await links[0].closed
        XCTAssertTrue(closed)
    }

    func testDroppedLinkReconnects() async {
        let sup = makeSupervisor([Script(), Script()])
        sup.activate()
        await until("live") { sup.state == .live }
        await links[0].drop()
        await until("live again") { sup.state == .live && links.count == 2 }
    }

    func testForegroundProbeReplacesADeadLiveLink() async {
        let sup = makeSupervisor([Script(probeAlive: false), Script()])
        sup.activate()
        await until("live") { sup.state == .live }
        sup.activate()   // back from the app switcher: the socket looks open but is dead
        await until("live on a fresh link") { sup.state == .live && links.count == 2 }
    }

    func testNetworkAvailableSkipsTheBackoff() async {
        let sup = makeSupervisor([Script(join: .fail(.transient("offline"))), Script()], backoff: [60])
        sup.activate()
        await until("waiting") { sup.state == .waiting }
        sup.networkAvailable()
        await until("live") { sup.state == .live }
    }

    func testRapidBackgroundForegroundEndsWithOneLiveLink() async {
        let sup = makeSupervisor([Script(), Script(), Script()])
        sup.activate()
        sup.deactivate()
        sup.activate()
        await until("live") { sup.state == .live }
        XCTAssertEqual(links.count, 2)
        let firstClosed = await links[0].closed
        let secondClosed = await links[1].closed
        XCTAssertTrue(firstClosed)
        XCTAssertFalse(secondClosed)
    }

    func testWaitUntilSettledReturnsTheFirstOutcome() async {
        let sup = makeSupervisor([Script()])
        sup.activate()
        await sup.waitUntilSettled()
        XCTAssertEqual(sup.state, .live)
    }
}
