import XCTest
@testable import EosRemoteKit

// Live cross-process E2E against daemon-impl's relay harness. GUARDED: skips unless EOS_LIVE_E2E=1,
// so it never runs in the normal suite. Coordinated run: daemon-impl starts the harness (writes the
// §6 pairing payload to /tmp/eos-pair.json + holds the offer up), then we run:
//   xcodebuild test ... -only-testing:EosRemoteKitTests/LiveE2ETests EOS_LIVE_E2E=1
// The Simulator process reads the host /tmp path directly, then runs the real PAIR choreography
// THROUGH the live relay and asserts welcome + a control round-trip.
final class LiveE2ETests: XCTestCase {
    private var collector: FrameCollector!

    func test_live_pair_and_control_through_relay() async throws {
        // Env vars don't propagate into the Simulator test process, so gate on a host-side sentinel
        // file (the Simulator reads host /tmp): `touch /tmp/eos-live-e2e-go` enables this run.
        let enabled = ProcessInfo.processInfo.environment["EOS_LIVE_E2E"] == "1"
            || FileManager.default.fileExists(atPath: "/tmp/eos-live-e2e-go")
        try XCTSkipUnless(enabled, "live relay E2E — touch /tmp/eos-live-e2e-go with the harness up")
        try CryptoSuite.ensureInit()

        let payloadPath = ProcessInfo.processInfo.environment["EOS_PAIR_FILE"] ?? "/tmp/eos-pair.json"
        let data = try Data(contentsOf: URL(fileURLWithPath: payloadPath))
        let qr = try QRPayload.decode(data, now: Date().timeIntervalSince1970)
        let relay = try XCTUnwrap(qr.relay)
        let bearer = try XCTUnwrap(qr.bearer)
        let url = try XCTUnwrap(URL(string: relay.url))

        collector = FrameCollector()
        let conn = WSConnection(url: url, mode: .relay(bearer: bearer), delegate: collector)
        let coordinator = PairingCoordinator(
            connection: conn, qr: qr, identity: SoftwareDeviceIdentity(),
            room: relay.room, pairBearer: bearer, devId: UUID().uuidString, label: "sim-e2e",
            log: { print("LIVE E2E step: \($0)") })

        // PAIR through the live relay, with a HARD timeout that actually tears down the socket so a
        // stalled handshake fails fast/diagnosably instead of blocking on a hung receive().
        let result: PairingCoordinator.PairResult? = try await withThrowingTaskGroup(
            of: PairingCoordinator.PairResult?.self) { group in
            group.addTask { try await coordinator.run() }
            group.addTask { try? await Task.sleep(nanoseconds: 25_000_000_000); return nil } // timeout → nil
            defer { group.cancelAll() }
            let first = try await group.next() ?? nil
            await conn.stop() // cancel the WS so the other child's receive() unblocks immediately
            return first
        }
        guard let result else {
            return XCTFail("PAIR timed out (25s) — no welcome. Check join-ack / PAIR-2 framing against harness logs.")
        }
        print("LIVE E2E paired — durableBearer len=\(result.durableBearer.count), ticket PSK bytes=\(result.ticket.psk.count)")
        XCTAssertFalse(result.durableBearer.isEmpty, "welcome must carry a durable bearer")
        XCTAssertEqual(result.ticket.psk.count, 32, "ticket PSK must be 32 bytes")

        // A real sealed control round-trip over the established session.
        let reply = try await conn.sendControl(method: "GET", path: "/workers", bodyData: Data("{}".utf8))
        XCTAssertEqual(reply.status, 200, "GET /workers must reply 200")
        let ids = (reply.body?.arrayValue ?? []).compactMap { $0["id"]?.stringValue }
        XCTAssertFalse(ids.isEmpty, "expected at least one worker from the harness (e.g. w-demo1)")
        print("LIVE E2E OK — paired, GET /workers → \(ids)")

        await conn.stop()
    }
}

// Retains the WSConnection delegate for the live run; captures pushed frames for optional assertions.
private final class FrameCollector: WSConnectionDelegate, @unchecked Sendable {
    var events: [String] = []
    func wsDidReceive(snapshot: SnapshotFrame) async {}
    func wsDidReceive(patch: PatchFrame) async {}
    func wsDidReceive(event: EventFrame) async { events.append(event.reason) }
    func wsDidReceive(challenge: ChallengeFrame) async {}
    func wsDidReceive(error: ErrorFrame) async { print("LIVE E2E relay/error: \(error.code)") }
    func wsConnectionStateChanged(connected: Bool) async {}
}
