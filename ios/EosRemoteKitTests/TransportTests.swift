import XCTest
@testable import EosRemoteKit

// Transport v3 (plaintext relay). Replaces the deleted Noise fixture tests. Covers:
//   • QR v3 parse — accept + the reject cases (§2)
//   • outer-envelope encode/decode round-trip (§4.4)
//   • the relay join-frame shape (§4.2)
//   • a BYTE-level match of the outer envelope against the desktop framer's exact output, so the
//     two ends provably agree without a live relay. The golden hex strings are produced by
//     manager/remote/envelope.ts for fixed inputs (see the fixture note on each test).
final class TransportTests: XCTestCase {

    // MARK: QR v3

    private func qrJSON(_ obj: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: obj) }
    private let room43 = String(repeating: "A", count: 43)   // ≥32-byte b64url floor
    private let bearer43 = String(repeating: "B", count: 43)

    func testQRAcceptsValidV3() throws {
        let json = qrJSON([
            "v": 3, "typ": "eos-pair", "relay": "wss://relay.example.com/",
            "room": room43, "bearer": bearer43, "exp": 9_999_999_999,
        ])
        let qr = try QRPayload.decode(json, now: 1_000)
        XCTAssertEqual(qr.v, 3)
        XCTAssertEqual(qr.relay, "wss://relay.example.com/")
        XCTAssertEqual(qr.room, room43)
        XCTAssertEqual(qr.bearer, bearer43)
        XCTAssertEqual(qr.relayURL, URL(string: "wss://relay.example.com/"))
    }

    func testQRAcceptsMissingBearer() throws {
        // bearer is optional in the schema (future room-id-only mode).
        let json = qrJSON([
            "v": 3, "typ": "eos-pair", "relay": "wss://r/", "room": room43, "exp": 9_999_999_999,
        ])
        let qr = try QRPayload.decode(json, now: 1_000)
        XCTAssertNil(qr.bearer)
    }

    func testQRRejectsWrongVersion() {
        let json = qrJSON([
            "v": 2, "typ": "eos-pair", "relay": "wss://r/", "room": room43, "exp": 9_999_999_999,
        ])
        XCTAssertThrowsError(try QRPayload.decode(json, now: 1_000)) {
            XCTAssertEqual($0 as? QRPayload.QRError, .badType)
        }
    }

    func testQRRejectsWrongType() {
        let json = qrJSON([
            "v": 3, "typ": "eos-nope", "relay": "wss://r/", "room": room43, "exp": 9_999_999_999,
        ])
        XCTAssertThrowsError(try QRPayload.decode(json, now: 1_000)) {
            XCTAssertEqual($0 as? QRPayload.QRError, .badType)
        }
    }

    func testQRRejectsShortRoom() {
        // A 22-char v2-sized room is below the v3 ≥32-byte (≥43 char) entropy floor.
        let json = qrJSON([
            "v": 3, "typ": "eos-pair", "relay": "wss://r/",
            "room": String(repeating: "A", count: 22), "exp": 9_999_999_999,
        ])
        XCTAssertThrowsError(try QRPayload.decode(json, now: 1_000)) {
            XCTAssertEqual($0 as? QRPayload.QRError, .badType)
        }
    }

    func testQRRejectsExpired() {
        let json = qrJSON([
            "v": 3, "typ": "eos-pair", "relay": "wss://r/", "room": room43, "exp": 500,
        ])
        XCTAssertThrowsError(try QRPayload.decode(json, now: 1_000)) {
            XCTAssertEqual($0 as? QRPayload.QRError, .expired)
        }
    }

    func testQRExpiryGuardCanBeDisabled() throws {
        let json = qrJSON([
            "v": 3, "typ": "eos-pair", "relay": "wss://r/", "room": room43, "exp": 500,
        ])
        let qr = try QRPayload.decode(json, now: 1_000, enforceExpiry: false)
        XCTAssertEqual(qr.v, 3)
    }

    func testQRRejectsMissingRelay() {
        // relay is required in v3 (relay-only reach).
        let json = qrJSON(["v": 3, "typ": "eos-pair", "room": room43, "exp": 9_999_999_999])
        XCTAssertThrowsError(try QRPayload.decode(json, now: 1_000))
    }

    // MARK: outer envelope

    func testEnvelopeRoundTrip() throws {
        let room = Bytes.ascii(String(repeating: "A", count: 22))
        let clientId = Bytes.fromHex("000102030405060708090a0b0c0d0e0f")!
        let payload = Data("the-inner-frame".utf8)
        let env = Envelope(type: .data, dir: .s2c, epoch: 0, seq: 0,
                           room: room, clientId: clientId, payload: payload)
        let decoded = try Envelope.decode(env.encode())
        XCTAssertEqual(decoded.type, .data)
        XCTAssertEqual(decoded.dir, .s2c)
        XCTAssertEqual(decoded.epoch, 0)
        XCTAssertEqual(decoded.seq, 0)
        XCTAssertEqual(decoded.room, room)
        XCTAssertEqual(decoded.clientId, clientId)
        XCTAssertEqual(decoded.payload, payload)
    }

    func testEnvelopePreservesFullU64Seq() throws {
        let env = Envelope(type: .data, dir: .c2s, epoch: 0, seq: .max,
                           room: Bytes.ascii("r"), clientId: Data(count: 16), payload: Data())
        XCTAssertEqual(try Envelope.decode(env.encode()).seq, .max)
    }

    func testEnvelopeRejectsShortBuffer() {
        XCTAssertThrowsError(try Envelope.decode(Data(count: 5))) {
            XCTAssertEqual($0 as? Envelope.EnvelopeError, .tooShort)
        }
    }

    func testEnvelopeRejectsBadVersion() {
        var bytes = [UInt8](repeating: 0, count: 29)
        bytes[0] = 0x02                       // wrong version
        bytes[12] = 0                         // roomLen 0 → header = 13 + 0 + 16 = 29
        XCTAssertThrowsError(try Envelope.decode(Data(bytes))) {
            XCTAssertEqual($0 as? Envelope.EnvelopeError, .badVersion)
        }
    }

    // MARK: byte-level cross-impl match (desktop manager/remote/envelope.ts)

    // Golden output of encodeEnvelope({ type:data, dir:s2c, epoch:0, seq:0n,
    //   room:"A"×22, clientId:00..0f, payload:"hello" }).
    func testDataEnvelopeMatchesDesktopBytes() {
        let expected = "0101010000000000000000001641414141414141414141414141414141414141414141"
                     + "000102030405060708090a0b0c0d0e0f68656c6c6f"
        let room = Bytes.ascii(String(repeating: "A", count: 22))
        let clientId = Bytes.fromHex("000102030405060708090a0b0c0d0e0f")!
        let env = Envelope(type: .data, dir: .s2c, epoch: 0, seq: 0,
                           room: room, clientId: clientId, payload: Data("hello".utf8))
        XCTAssertEqual(Bytes.hex(env.encode()), expected, "data envelope bytes diverge from the desktop framer")
    }

    // Golden output of encodeJsonEnvelope({ type:join, dir:c2s, room:"A"×22,
    //   json:{t:"join", room:"A"×22, bearer:"the-bearer"} }) — clientId defaults to all-zero.
    // The join payload's JSON is key-order-sensitive; Swift must emit {"t","room","bearer"} in order.
    func testJoinFrameMatchesDesktopBytes() throws {
        let expected = "0103000000000000000000001641414141414141414141414141414141414141414141"
                     + "000000000000000000000000000000007b2274223a226a6f696e222c22726f6f6d223a"
                     + "2241414141414141414141414141414141414141414141222c22626561726572223a22"
                     + "7468652d626561726572227d"
        let room = String(repeating: "A", count: 22)
        // Match the desktop payload byte-for-byte via a key-ordered literal ({"t","room","bearer"}),
        // since JSON key order is what makes the outer-envelope bytes agree.
        let payload = Data(#"{"t":"join","room":"\#(room)","bearer":"the-bearer"}"#.utf8)
        let env = Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                           room: Bytes.ascii(room), clientId: Data(count: 16), payload: payload)
        XCTAssertEqual(Bytes.hex(env.encode()), expected, "join envelope bytes diverge from the desktop framer")
    }

    // MARK: join-frame shape (what the Connector puts on the wire)

    func testJoinFrameShape() throws {
        let room = String(repeating: "A", count: 43)
        let joinJSON = try JSONSerialization.data(withJSONObject: [
            "t": "join", "room": room, "bearer": "the-bearer",
        ])
        let env = Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                           room: Bytes.ascii(room), clientId: Data(count: 16), payload: joinJSON)
        let decoded = try Envelope.decode(env.encode())
        XCTAssertEqual(decoded.type, .join)
        XCTAssertEqual(decoded.dir, .c2s)
        XCTAssertEqual(decoded.clientId, Data(count: 16))   // zero until the relay assigns one
        let obj = try JSONSerialization.jsonObject(with: decoded.payload) as? [String: String]
        XCTAssertEqual(obj?["t"], "join")
        XCTAssertEqual(obj?["room"], room)
        XCTAssertEqual(obj?["bearer"], "the-bearer")
    }

    // MARK: session codecs (plaintext framer parity with the desktop)

    func testSessionFramesRoundTrip() throws {
        let session = SessionState(room: Bytes.ascii(String(repeating: "A", count: 22)),
                                   clientId: Bytes.fromHex("000102030405060708090a0b0c0d0e0f")!)
        let inner = Data(#"{"t":"ka","ts":0}"#.utf8)
        let wire = session.frameToEnvelope(inner)                  // c2s data envelope
        let env = try Envelope.decode(wire)
        XCTAssertEqual(env.type, .data)
        XCTAssertEqual(env.dir, .c2s)
        XCTAssertEqual(session.envelopeToJSON(env), inner)         // payload comes back verbatim
    }
}
