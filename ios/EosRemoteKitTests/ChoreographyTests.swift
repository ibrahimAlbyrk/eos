import XCTest
@testable import EosRemoteKit

// End-to-end wire-glue proof: run the FULL client PAIR choreography (HandshakeDriver) against the
// committed golden fixture's fixed ephemerals, and assert the session it derives reproduces the
// golden traffic keys AND seals the {"t":"ka","ts":0} data frame to the exact ciphertext‖tag gate.
// This validates that the live choreography (PairingCoordinator) is wired to spec, deterministically,
// without needing a live relay. Also round-trips the join / cleartext-hs / sealed-welcome framing.
final class ChoreographyTests: XCTestCase {
    private var vectors: [String: Any]!
    private var inputs: [String: Any]!

    override func setUpWithError() throws {
        try CryptoSuite.ensureInit()
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("docs/vectors/ios-remote-v1")
        vectors = try XCTUnwrap(JSONSerialization.jsonObject(
            with: try Data(contentsOf: dir.appendingPathComponent("vectors.json"))) as? [String: Any])
        inputs = try XCTUnwrap(vectors["inputs"] as? [String: Any])
    }

    private func ihex(_ k: String) throws -> Data { try XCTUnwrap(Bytes.fromHex(try XCTUnwrap(inputs[k] as? String))) }
    private func vhex(_ a: String, _ b: String) throws -> Data {
        let o = try XCTUnwrap(vectors[a] as? [String: Any])
        return try XCTUnwrap(Bytes.fromHex(try XCTUnwrap(o[b] as? String)))
    }
    private func eq(_ got: Data, _ want: Data, _ m: String) { XCTAssertEqual(Bytes.hex(got), Bytes.hex(want), m) }

    private func fixtureQR() throws -> QRPayload {
        // A QR whose pinned Mac key is the fixture I_mac; the device asserts this in PAIR-2.
        let json: [String: Any] = [
            "v": 1, "typ": "eos-pair",
            "macPub": Bytes.b64u(try ihex("iMacPub")),
            "ots": Bytes.b64u(try ihex("ots")),
            "otsExp": 9_999_999_999.0,
            "lan": [],
            "relay": ["url": "wss://example.invalid/", "room": String(decoding: try room(), as: UTF8.self)],
            "bearer": Bytes.b64u(Data(count: 32)),
            "exp": 9_999_999_999.0,
        ]
        return try QRPayload.decode(try JSONSerialization.data(withJSONObject: json), now: 0)
    }
    private func room() throws -> Data { Bytes.ascii(try XCTUnwrap(inputs["room"] as? String)) }

    // The full client PAIR run over fixed fixture ephemerals → golden session + golden ka gate.
    func test_full_pair_choreography_reproduces_golden_session_and_ka_gate() throws {
        let clientId = try ihex("clientId")
        let driver = HandshakeDriver(mode: .pair, qr: try fixtureQR(),
                                     identity: SoftwareDeviceIdentity(), clientId: clientId, room: try room())

        // PAIR-1 with the fixture's fixed ephemeral + client nonce.
        let kp = CryptoSuite.KxKeypair(publicKey: try ihex("ePubC"), secretKey: try ihex("eSecC"))
        let hello = driver.makeHello(kp: kp, clientNonce: try ihex("clientNonce"))
        XCTAssertEqual(hello["ePubC"], Bytes.b64u(try ihex("ePubC")))
        XCTAssertEqual(hello["nC"], Bytes.b64u(try ihex("clientNonce")))

        // PAIR-2: feed the fixture's server hello → pin-assert + Mac-sig verify + encS open all pass.
        let s2 = HandshakeDriver.ServerHello(ePubS: try ihex("ePubS"),
                                             serverNonce: try ihex("serverNonce"),
                                             encS: try vhex("sealed", "encS"))
        let (th2, _) = try driver.processServerHello(s2)
        eq(th2, try vhex("transcript", "th2"), "TH2 through processServerHello")

        // PAIR-3: derive the live session (sigC is fresh/random — session keys don't depend on it).
        let auth = try driver.buildClientAuth(serverHello: s2, devId: "00000000-0000-4000-8000-000000000001",
                                              label: "fixture-device", reason: "test")
        eq(auth.session.sessionTH, try vhex("transcript", "th3"), "sessionTH == TH3")
        eq(auth.session.kC2sFinal, try vhex("trafficKeys", "kC2sFinal"), "K_c2s_final")
        eq(auth.session.kS2cFinal, try vhex("trafficKeys", "kS2cFinal"), "K_s2c_final")

        // THE GATE through the full choreography: seal {"t":"ka","ts":0} with the derived session.
        let kaPlain = try XCTUnwrap(Bytes.fromHex(try XCTUnwrap(
            (vectors["dataFrameKa"] as? [String: Any])?["plaintextHex"] as? String)))
        let env = try Envelope.decode(try auth.session.sealOutgoing(kaPlain))
        XCTAssertEqual(env.type, .data); XCTAssertEqual(env.dir, .c2s); XCTAssertEqual(env.seq, 0)
        eq(env.payload, try vhex("dataFrameKa", "ciphertextTag"), "ka ciphertext‖tag GATE via choreography")
        eq(env.aad(), try vhex("dataFrameKa", "aad"), "envelope AAD via choreography")
    }

    // Sealed welcome (s2c seq0): the session opens a daemon-sealed reply{correlationId:"pair"}.
    func test_sealed_welcome_open() throws {
        let driver = HandshakeDriver(mode: .pair, qr: try fixtureQR(),
                                     identity: SoftwareDeviceIdentity(), clientId: try ihex("clientId"), room: try room())
        _ = driver.makeHello(kp: CryptoSuite.KxKeypair(publicKey: try ihex("ePubC"), secretKey: try ihex("eSecC")),
                             clientNonce: try ihex("clientNonce"))
        let s2 = HandshakeDriver.ServerHello(ePubS: try ihex("ePubS"), serverNonce: try ihex("serverNonce"),
                                             encS: try vhex("sealed", "encS"))
        _ = try driver.processServerHello(s2)
        let session = try driver.buildClientAuth(serverHello: s2, devId: "d", label: "l", reason: "t").session

        // Mac seals the welcome with kS2cFinal at dir s2c / seq0, full data-frame AAD.
        let welcome = Data(#"{"t":"reply","correlationId":"pair","status":200,"body":{"bearer":"BBB","ticket":{"ticketId":"AAAAAAAAAAAAAAAAAAAAAA","psk":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","idleExp":1,"absExp":2}}}"#.utf8)
        let aad = Envelope.aad(epoch: 0, dir: .s2c, seq: 0, room: try room(), clientId: try ihex("clientId"))
        let ct = try CryptoSuite.aeadSeal(key: session.kS2cFinal, npub: Nonce.make(epoch: 0, dir: .s2c, seq: 0),
                                          aad: aad, plaintext: welcome)
        let env = Envelope(type: .data, dir: .s2c, epoch: 0, seq: 0,
                           room: try room(), clientId: try ihex("clientId"), payload: ct)

        let opened = try session.openIncoming(env)
        guard case .reply(let r) = try ServerFrame.decode(opened) else { return XCTFail("not a reply") }
        XCTAssertEqual(r.correlationId, "pair")
        XCTAssertEqual(r.body?["bearer"]?.stringValue, "BBB")
        XCTAssertEqual(r.body?["ticket"]?["ticketId"]?.stringValue, "AAAAAAAAAAAAAAAAAAAAAA")
    }

    // Outer-envelope framing round-trips for join (type=0x03) and cleartext hs (type=0x01).
    func test_envelope_framing_roundtrip() throws {
        let join = Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                            room: try room(), clientId: Data(count: 16),
                            payload: Data(#"{"t":"join"}"#.utf8))
        let back = try Envelope.decode(join.encode())
        XCTAssertEqual(back.type, .join)
        XCTAssertEqual(back.clientId, Data(count: 16))
        eq(back.room, try room(), "room round-trip")
        XCTAssertEqual(back.payload, Data(#"{"t":"join"}"#.utf8))
    }

    // §3.4: bodyHash over the opaque body string content matches the fixture (serialize-once rule).
    func test_stepup_body_hash_opaque_string() throws {
        let bodyStr = try XCTUnwrap(inputs["sampleStepUpBody"] as? String)  // {"signal":"TERM"}
        eq(try HandshakeCrypto.bodyHash(Data(bodyStr.utf8)), try vhex("stepUp", "bodyHash"), "bodyHash of opaque body string")
    }
}
