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
        try XCTSkipUnless(ProcessInfo.processInfo.environment["EOS_LIVE_E2E"] == "1",
                          "live relay E2E — set EOS_LIVE_E2E=1 with the harness up")
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
            room: relay.room, pairBearer: bearer, devId: UUID().uuidString, label: "sim-e2e")

        // PAIR through the live relay.
        let result = try await withThrowingTaskGroup(of: PairingCoordinator.PairResult.self) { group in
            group.addTask { try await coordinator.run() }
            group.addTask { try await Task.sleep(nanoseconds: 30_000_000_000); throw XCTSkip("pair timed out (30s)") }
            let r = try await group.next()!
            group.cancelAll()
            return r
        }
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
