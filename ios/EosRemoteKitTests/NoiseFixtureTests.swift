import XCTest
@testable import EosRemoteKit

// Byte-equality against the committed golden Noise_IK fixture
// (docs/vectors/ios-remote-v2/), the cross-platform interop gate. The Swift Noise
// state machine MUST reproduce the daemon's reference bytes exactly. msg1 / msg2
// and dataFrameKa.ciphertextTag are the go/no-go check.
final class NoiseFixtureTests: XCTestCase {
    private func fixtureDir() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // EosRemoteKitTests
            .deletingLastPathComponent()   // ios
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("docs/vectors/ios-remote-v2", isDirectory: true)
    }

    private var v: [String: Any]!
    private var inputs: [String: Any]!
    private var derived: [String: Any]!

    override func setUpWithError() throws {
        try CryptoSuite.ensureInit()
        let data = try Data(contentsOf: fixtureDir().appendingPathComponent("vectors.json"))
        v = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        inputs = try XCTUnwrap(v["inputs"] as? [String: Any])
        derived = try XCTUnwrap(v["derived"] as? [String: Any])
    }

    private func ihex(_ k: String) throws -> Data { try XCTUnwrap(Bytes.fromHex(try XCTUnwrap(inputs[k] as? String))) }
    private func istr(_ k: String) throws -> String { try XCTUnwrap(inputs[k] as? String) }
    private func vstr(_ section: String, _ k: String) throws -> String {
        let s = try XCTUnwrap(v[section] as? [String: Any])
        return try XCTUnwrap(s[k] as? String)
    }

    private func deviceStatic() throws -> NoiseDH.Keypair {
        let sec = try ihex("deviceStaticSec"); return NoiseDH.Keypair(pub: NoiseDH.pub(sec), sec: sec)
    }
    private func macStatic() throws -> NoiseDH.Keypair {
        let sec = try ihex("macStaticSec"); return NoiseDH.Keypair(pub: NoiseDH.pub(sec), sec: sec)
    }
    private func deviceEph() throws -> NoiseDH.Keypair {
        let sec = try ihex("deviceEphSec"); return NoiseDH.Keypair(pub: NoiseDH.pub(sec), sec: sec)
    }
    private func macEph() throws -> NoiseDH.Keypair {
        let sec = try ihex("macEphSec"); return NoiseDH.Keypair(pub: NoiseDH.pub(sec), sec: sec)
    }

    func test_derived_pubkeys_match() throws {
        XCTAssertEqual(Bytes.hex(try deviceStatic().pub), try istr("deviceStaticPub"))
        XCTAssertEqual(Bytes.hex(try macStatic().pub), try istr("macStaticPub"))
        XCTAssertEqual(Bytes.hex(try deviceEph().pub), try istr("deviceEphPub"))
        XCTAssertEqual(Bytes.hex(try macEph().pub), try istr("macEphPub"))
    }

    func test_relayDeviceId() throws {
        XCTAssertEqual(NoiseIdentity.relayDeviceId(try deviceStatic().pub),
                       try XCTUnwrap(derived["relayDeviceIdB64u"] as? String))
    }

    func test_enroll_msg1_matches() throws {
        let payload1 = NoiseIdentity.buildEnrollPayload(token: try istr("enrollTokenB64u"), label: try istr("label"))
        XCTAssertEqual(String(decoding: payload1, as: UTF8.self),
                       try XCTUnwrap(derived["enrollPayload1Utf8"] as? String))
        let init1 = NoiseInitiator(deviceStatic: try deviceStatic(), macStaticPub: try macStatic().pub, testEphemeral: try deviceEph())
        let msg1 = try init1.writeMessage1(payload1)
        XCTAssertEqual(Bytes.hex(msg1), try vstr("handshake", "msg1"), "msg1 MISMATCH")
    }

    func test_steady_msg1_matches() throws {
        let init1 = NoiseInitiator(deviceStatic: try deviceStatic(), macStaticPub: try macStatic().pub, testEphemeral: try deviceEph())
        let msg1 = try init1.writeMessage1(NoiseIdentity.steadyPayload)
        XCTAssertEqual(Bytes.hex(msg1), try vstr("handshake", "msg1Steady"), "steady msg1 MISMATCH")
    }

    func test_responder_msg2_and_keys_agree() throws {
        let payload1 = NoiseIdentity.buildEnrollPayload(token: try istr("enrollTokenB64u"), label: try istr("label"))
        let init1 = NoiseInitiator(deviceStatic: try deviceStatic(), macStaticPub: try macStatic().pub, testEphemeral: try deviceEph())
        let msg1 = try init1.writeMessage1(payload1)

        let resp = NoiseResponder(macStatic: try macStatic(), testEphemeral: try macEph())
        let r1 = try resp.readMessage1(msg1)
        XCTAssertEqual(Bytes.hex(r1.deviceStaticPub), try istr("deviceStaticPub"))

        let (msg2, rkeys) = try resp.writeMessage2(Data())
        XCTAssertEqual(Bytes.hex(msg2), try vstr("handshake", "msg2"), "msg2 MISMATCH")
        XCTAssertEqual(Bytes.hex(rkeys.kC2sFinal), try vstr("splitKeys", "kC2sFinal"))
        XCTAssertEqual(Bytes.hex(rkeys.kS2cFinal), try vstr("splitKeys", "kS2cFinal"))
        XCTAssertEqual(Bytes.hex(rkeys.sessionTH), try vstr("splitKeys", "sessionTH"))

        let r2 = try init1.readMessage2(msg2)
        XCTAssertEqual(Bytes.hex(r2.keys.kC2sFinal), try vstr("splitKeys", "kC2sFinal"))
        XCTAssertEqual(Bytes.hex(r2.keys.sessionTH), try vstr("splitKeys", "sessionTH"))
    }

    func test_transport_ka_gate() throws {
        let payload1 = NoiseIdentity.buildEnrollPayload(token: try istr("enrollTokenB64u"), label: try istr("label"))
        let init1 = NoiseInitiator(deviceStatic: try deviceStatic(), macStaticPub: try macStatic().pub, testEphemeral: try deviceEph())
        let msg1 = try init1.writeMessage1(payload1)
        let resp = NoiseResponder(macStatic: try macStatic(), testEphemeral: try macEph())
        _ = try resp.readMessage1(msg1)
        let (msg2, _) = try resp.writeMessage2(Data())
        let r2 = try init1.readMessage2(msg2)

        let ka = try XCTUnwrap((v["dataFrameKa"] as? [String: Any])?["plaintextUtf8"] as? String)
        let room = Data(try istr("room").utf8)
        let clientId = try ihex("clientId")
        let npub = Nonce.make(epoch: 0, dir: .c2s, seq: 0)
        let aad = Envelope.aad(epoch: 0, dir: .c2s, seq: 0, room: room, clientId: clientId)
        let ct = try CryptoSuite.aeadSeal(key: r2.keys.kC2sFinal, npub: npub, aad: aad, plaintext: Data(ka.utf8))
        XCTAssertEqual(Bytes.hex(ct), try XCTUnwrap((v["dataFrameKa"] as? [String: Any])?["ciphertextTag"] as? String), "ka gate MISMATCH")
    }
}
