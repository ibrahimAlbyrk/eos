import Foundation

// Cold PAIR / CONNECT / RESUME handshake construction (§2). This drives the crypto: it builds
// each outgoing inner frame and verifies each incoming one, ending in a SessionState with live
// traffic keys. The network choreography (sending these through the WS, awaiting the peer frame)
// is the caller's; this type owns the byte-exact crypto so it is unit-testable against the spec.
public final class HandshakeDriver {
    public enum HandshakeError: Error { case macPinMismatch, badServerSig, badServerFrame, otsMissing, state }

    private let mode: HandshakeMode
    private let qr: QRPayload
    private let identity: DeviceIdentity
    private let clientId: Data
    private let room: Data

    // session-scoped ephemerals + nonces
    private var eph: CryptoSuite.KxKeypair?
    private var clientNonce = Data()
    private var kx: CryptoSuite.SessionKeys?

    public init(mode: HandshakeMode, qr: QRPayload, identity: DeviceIdentity, clientId: Data, room: Data) {
        self.mode = mode; self.qr = qr; self.identity = identity; self.clientId = clientId; self.room = room
    }

    // PAIR-1 / CONNECT-1: announce ephemeral pub + client nonce.
    public func buildHello() throws -> [String: String] {
        try makeHello(kp: CryptoSuite.generateKxKeypair(), clientNonce: randomBytes(16))
    }

    // Deterministic hello — fixed ephemerals/nonce for the golden-fixture choreography test.
    func makeHello(kp: CryptoSuite.KxKeypair, clientNonce: Data) -> [String: String] {
        self.eph = kp
        self.clientNonce = clientNonce
        return ["v": "1", "t": "hs", "step": "1",
                "mode": mode == .connect ? "connect" : "pair",
                "ePubC": Bytes.b64u(kp.publicKey),
                "nC": Bytes.b64u(clientNonce)]
    }

    // PAIR-2 / CONNECT-2: verify the Mac. Returns the derived TH2 (for the caller's records).
    public struct ServerHello { public let ePubS: Data; public let serverNonce: Data; public let encS: Data }
    public func processServerHello(_ s: ServerHello) throws -> (th2: Data, th3Inputs: Data) {
        guard let eph else { throw HandshakeError.state }
        let kx = try CryptoSuite.clientSessionKeys(ePubC: eph.publicKey, eSecC: eph.secretKey, ePubS: s.ePubS)
        self.kx = kx

        let th2 = try HandshakeCrypto.th2(ePubC: eph.publicKey, clientNonce: clientNonce,
                                          ePubS: s.ePubS, serverNonce: s.serverNonce)
        let kHsS2c = try HandshakeCrypto.hsKeyS2c(kS2c: kx.rx, th2: th2)
        let s2plain = try CryptoSuite.aeadOpen(key: kHsS2c, npub: Nonce.make(epoch: 0, dir: .s2c, seq: 0),
                                               aad: Data(), ciphertext: s.encS)
        let s2 = try JSONDecoder().decode(S2.self, from: s2plain)
        guard let iMac = Bytes.fromB64u(s2.iMac), let sigS = Bytes.fromB64u(s2.sigS) else {
            throw HandshakeError.badServerFrame
        }
        // Pin assertion: the Mac identity MUST equal the QR-pinned key (fail = MITM, §2.1 ④).
        guard let pinned = qr.macPubData, iMac == pinned else { throw HandshakeError.macPinMismatch }
        let macMsg = HandshakeCrypto.macSigMessage(mode: mode, th2: th2)
        guard try P256Identity.verify(message: macMsg, signature: sigS, publicKeySEC1: iMac) else {
            throw HandshakeError.badServerSig
        }
        // TH3 folds in encS; return it so buildClientAuth can use the same bytes.
        return (th2, s.encS)
    }

    // PAIR-3 / CONNECT-3: sign the transcript (Face ID via SE), seal the device identity. The OTS
    // proof is included only for PAIR. Produces the sealed frame AND the live SessionState.
    public struct ClientAuthResult { public let frame: [String: String]; public let session: SessionState }
    public func buildClientAuth(serverHello s: ServerHello, devId: String, label: String, reason: String) throws -> ClientAuthResult {
        guard let eph, let kx else { throw HandshakeError.state }
        let th3 = try HandshakeCrypto.th3(ePubC: eph.publicKey, clientNonce: clientNonce,
                                          ePubS: s.ePubS, serverNonce: s.serverNonce, encS: s.encS)
        let kHsC2s = try HandshakeCrypto.hsKeyC2s(kC2s: kx.tx, th3: th3)
        let sigC = try identity.sign(HandshakeCrypto.deviceSigMessage(mode: mode, th3: th3), reason: reason)

        var c3: [String: String] = [
            "iDev": Bytes.b64u(identity.publicKeySEC1),
            "devId": devId, "label": label,
            "sigC": Bytes.b64u(sigC),
        ]
        if mode == .pair {
            guard let ots = qr.otsData else { throw HandshakeError.otsMissing }
            let proof = try HandshakeCrypto.otsProof(th3: th3, ots: ots)
            c3["ots"] = Bytes.b64u(proof)
        }
        let c3plain = try JSONSerialization.data(withJSONObject: c3, options: [.sortedKeys])
        let encC = try CryptoSuite.aeadSeal(key: kHsC2s, npub: Nonce.make(epoch: 0, dir: .c2s, seq: 0),
                                            aad: Data(), plaintext: c3plain)

        let tk = try HandshakeCrypto.trafficKeys(kC2s: kx.tx, kS2c: kx.rx, th3: th3)
        let session = SessionState(kC2sFinal: tk.c2s, kS2cFinal: tk.s2c, sessionTH: th3,
                                   room: room, clientId: clientId, isResumed: false)
        let frame = ["v": "1", "t": "hs", "step": "3",
                     "mode": mode == .connect ? "connect" : "pair",
                     "encC": Bytes.b64u(encC)]
        return ClientAuthResult(frame: frame, session: session)
    }

    private struct S2: Codable { let iMac: String; let sigS: String }

    private func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }
}
