import XCTest
@testable import EosRemoteKit

// Byte-equality against the committed golden fixture (docs/vectors/ios-remote-v1/), the §9.2
// cross-platform interop gate. The Swift libsodium + CryptoKit outputs MUST reproduce the Node
// daemon's reference bytes exactly. dataFrameKa.ciphertextTag is the go/no-go check.
final class CryptoFixtureTests: XCTestCase {
    // The fixture lives at <repo>/docs/vectors/ios-remote-v1/. This file is at
    // <repo>/ios/EosRemoteKitTests/, so the repo root is two directories up. The Simulator runs
    // on the host and can read the host filesystem, so we read the canonical committed file
    // directly rather than bundling a copy that could drift.
    private func fixtureDir() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // EosRemoteKitTests
            .deletingLastPathComponent()   // ios
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("docs/vectors/ios-remote-v1", isDirectory: true)
    }

    private func loadJSON(_ name: String) throws -> [String: Any] {
        let url = fixtureDir().appendingPathComponent(name)
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private var vectors: [String: Any]!
    private var inputs: [String: Any]!

    override func setUpWithError() throws {
        try CryptoSuite.ensureInit()
        vectors = try loadJSON("vectors.json")
        inputs = try XCTUnwrap(vectors["inputs"] as? [String: Any])
    }

    // MARK: helpers
    private func hex(_ keypath: [String], in root: [String: Any]) throws -> Data {
        var node: Any = root
        for k in keypath {
            let dict = try XCTUnwrap(node as? [String: Any], "missing \(keypath)")
            node = try XCTUnwrap(dict[k], "missing key \(k) in \(keypath)")
        }
        let s = try XCTUnwrap(node as? String, "not a string: \(keypath)")
        return try XCTUnwrap(Bytes.fromHex(s), "bad hex: \(keypath)")
    }
    private func vhex(_ keypath: String...) throws -> Data { try hex(keypath, in: vectors) }
    private func ihex(_ key: String) throws -> Data { try hex([key], in: inputs) }

    private func assertEq(_ got: Data, _ want: Data, _ label: String) {
        XCTAssertEqual(Bytes.hex(got), Bytes.hex(want), "MISMATCH \(label)")
    }

    // MARK: tests

    func test_crypto_kx_directional_keys() throws {
        let keys = try CryptoSuite.clientSessionKeys(
            ePubC: try ihex("ePubC"), eSecC: try ihex("eSecC"), ePubS: try ihex("ePubS"))
        // device = CLIENT: tx = K_c2s, rx = K_s2c (§1.3).
        assertEq(keys.tx, try vhex("kx", "kC2s"), "K_c2s")
        assertEq(keys.rx, try vhex("kx", "kS2c"), "K_s2c")
    }

    func test_transcript_hashes() throws {
        let th2 = try HandshakeCrypto.th2(
            ePubC: try ihex("ePubC"), clientNonce: try ihex("clientNonce"),
            ePubS: try ihex("ePubS"), serverNonce: try ihex("serverNonce"))
        assertEq(th2, try vhex("transcript", "th2"), "TH2")

        let th3 = try HandshakeCrypto.th3(
            ePubC: try ihex("ePubC"), clientNonce: try ihex("clientNonce"),
            ePubS: try ihex("ePubS"), serverNonce: try ihex("serverNonce"),
            encS: try vhex("sealed", "encS"))
        assertEq(th3, try vhex("transcript", "th3"), "TH3")
    }

    func test_handshake_and_traffic_keys() throws {
        let kC2s = try vhex("kx", "kC2s")
        let kS2c = try vhex("kx", "kS2c")
        let th2 = try vhex("transcript", "th2")
        let th3 = try vhex("transcript", "th3")

        assertEq(try HandshakeCrypto.hsKeyS2c(kS2c: kS2c, th2: th2),
                 try vhex("handshakeKeys", "kHsS2c"), "K_hs_s2c")
        assertEq(try HandshakeCrypto.hsKeyC2s(kC2s: kC2s, th3: th3),
                 try vhex("handshakeKeys", "kHsC2s"), "K_hs_c2s")

        let tk = try HandshakeCrypto.trafficKeys(kC2s: kC2s, kS2c: kS2c, th3: th3)
        assertEq(tk.c2s, try vhex("trafficKeys", "kC2sFinal"), "K_c2s_final")
        assertEq(tk.s2c, try vhex("trafficKeys", "kS2cFinal"), "K_s2c_final")
    }

    func test_ots_proof() throws {
        let proof = try HandshakeCrypto.otsProof(th3: try vhex("transcript", "th3"), ots: try ihex("ots"))
        assertEq(proof, try vhex("otsProof"), "otsProof")
    }

    // Sealed handshake identity frames: deterministic given the pinned signatures inside the plaintext.
    func test_sealed_handshake_frames() throws {
        let sealed = try XCTUnwrap(vectors["sealed"] as? [String: Any])
        let s2Plain = Bytes.ascii(try XCTUnwrap(sealed["s2Plaintext"] as? String))
        let c3Plain = Bytes.ascii(try XCTUnwrap(sealed["c3Plaintext"] as? String))

        let encS = try CryptoSuite.aeadSeal(
            key: try vhex("handshakeKeys", "kHsS2c"),
            npub: Nonce.make(epoch: 0, dir: .s2c, seq: 0),
            aad: Data(), plaintext: s2Plain)
        assertEq(encS, try vhex("sealed", "encS"), "encS")

        let encC = try CryptoSuite.aeadSeal(
            key: try vhex("handshakeKeys", "kHsC2s"),
            npub: Nonce.make(epoch: 0, dir: .c2s, seq: 0),
            aad: Data(), plaintext: c3Plain)
        assertEq(encC, try vhex("sealed", "encC"), "encC")
    }

    // THE GO/NO-GO GATE: AEAD seal of {"t":"ka","ts":0} under K_c2s_final, epoch0/dir c2s/seq0.
    func test_dataFrameKa_gate() throws {
        let ka = try XCTUnwrap(vectors["dataFrameKa"] as? [String: Any])
        let plaintext = try XCTUnwrap(Bytes.fromHex(try XCTUnwrap(ka["plaintextHex"] as? String)))
        let npub = try vhex("dataFrameKa", "npub")
        let aad = try vhex("dataFrameKa", "aad")

        // Independently confirm our envelope codec produces the same AAD the fixture pins.
        let builtAAD = Envelope.aad(
            epoch: 0, dir: .c2s, seq: 0,
            room: Bytes.ascii(try XCTUnwrap(inputs["room"] as? String)),
            clientId: try ihex("clientId"))
        assertEq(builtAAD, aad, "envelope AAD vs fixture")

        let ct = try CryptoSuite.aeadSeal(
            key: try vhex("trafficKeys", "kC2sFinal"),
            npub: npub, aad: aad, plaintext: plaintext)
        assertEq(ct, try vhex("dataFrameKa", "ciphertextTag"), "dataFrameKa.ciphertextTag (GATE)")

        // Round-trip: open it back.
        let opened = try CryptoSuite.aeadOpen(
            key: try vhex("trafficKeys", "kC2sFinal"),
            npub: npub, aad: aad, ciphertext: ct)
        assertEq(opened, plaintext, "ka round-trip")
    }

    // P-256 verify KAT over the transcript-bound signed messages (§3.1).
    func test_p256_identity_verify() throws {
        let macMsg = HandshakeCrypto.macSigMessage(mode: .pair, th2: try vhex("transcript", "th2"))
        XCTAssertTrue(try P256Identity.verify(
            message: macMsg, signature: try ihex("sigS"), publicKeySEC1: try ihex("iMacPub")),
            "Mac sig_s must verify over pair-server label ‖ TH2")

        let devMsg = HandshakeCrypto.deviceSigMessage(mode: .pair, th3: try vhex("transcript", "th3"))
        XCTAssertTrue(try P256Identity.verify(
            message: devMsg, signature: try ihex("sigC"), publicKeySEC1: try ihex("iDevPub")),
            "Device sig_c must verify over pair-client label ‖ TH3")

        // Negative: a tampered message must fail.
        XCTAssertFalse(try P256Identity.verify(
            message: macMsg + Data([0x00]), signature: try ihex("sigS"), publicKeySEC1: try ihex("iMacPub")),
            "tampered message must not verify")
    }

    func test_resume_path() throws {
        let ticketId = try hex(["resume", "ticketId"], in: inputs)
        let psk = try hex(["resume", "psk"], in: inputs)
        let ePubC = try ihex("ePubC"); let ePubS = try ihex("ePubS")
        let cn = try ihex("clientNonce"); let sn = try ihex("serverNonce")
        let kC2s = try vhex("kx", "kC2s"); let kS2c = try vhex("kx", "kS2c")

        let thResume = try HandshakeCrypto.thResume(
            ticketId: ticketId, ePubC: ePubC, clientNonce: cn, ePubS: ePubS, serverNonce: sn)
        assertEq(thResume, try vhex("resume", "thResume"), "thResume")

        let thWithKx = try HandshakeCrypto.thWithKx(thResume: thResume, kC2s: kC2s, kS2c: kS2c)
        assertEq(thWithKx, try vhex("resume", "thWithKx"), "thWithKx")

        assertEq(try HandshakeCrypto.binderC(psk: psk, ticketId: ticketId, ePubC: ePubC, clientNonce: cn),
                 try vhex("resume", "binderC"), "binderC")
        assertEq(try HandshakeCrypto.binderS(psk: psk, ticketId: ticketId, ePubS: ePubS, serverNonce: sn, ePubC: ePubC),
                 try vhex("resume", "binderS"), "binderS")

        let rk = try HandshakeCrypto.resumeTrafficKeys(psk: psk, thWithKx: thWithKx)
        assertEq(rk.c2s, try vhex("resume", "kC2sResume"), "kC2sResume")
        assertEq(rk.s2c, try vhex("resume", "kS2cResume"), "kS2cResume")
    }

    func test_stepup_body_hash() throws {
        let body = Bytes.ascii(try XCTUnwrap(inputs["sampleStepUpBody"] as? String))
        assertEq(try HandshakeCrypto.bodyHash(body), try vhex("stepUp", "bodyHash"), "stepUp.bodyHash")
    }
}
