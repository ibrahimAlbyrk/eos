import Foundation

// Warm RESUME (§2.3): PSK-(EC)DHE re-auth, no P-256 signature, no Face ID. Produces a live
// SessionState (read + low-risk caps only) and the rotated replacement ticket.
public final class ResumeDriver {
    public enum ResumeError: Error { case badServerBinder, state }

    private let ticket: ResumptionTicket
    private let clientId: Data
    private let room: Data
    private var eph: CryptoSuite.KxKeypair?
    private var clientNonce = Data()

    public init(ticket: ResumptionTicket, clientId: Data, room: Data) {
        self.ticket = ticket; self.clientId = clientId; self.room = room
    }

    // RES-1.
    public func buildResume1() throws -> [String: String] {
        let kp = try CryptoSuite.generateKxKeypair()
        eph = kp
        clientNonce = randomBytes(16)
        let binderC = try HandshakeCrypto.binderC(psk: ticket.psk, ticketId: ticket.ticketId,
                                                  ePubC: kp.publicKey, clientNonce: clientNonce)
        return ["v": "1", "t": "resume",
                "ticketId": Bytes.b64u(ticket.ticketId),
                "ePubC": Bytes.b64u(kp.publicKey),
                "nC": Bytes.b64u(clientNonce),
                "binder": Bytes.b64u(binderC)]
    }

    public struct ServerResume { public let ePubS: Data; public let serverNonce: Data; public let binder: Data; public let encTicket: Data }
    public struct ResumeResult { public let session: SessionState; public let newTicket: ResumptionTicket }

    // RES-2: verify the Mac binder, derive PSK-(EC)DHE traffic keys, open the rotated ticket.
    public func processResumeOk(_ s: ServerResume) throws -> ResumeResult {
        guard let eph else { throw ResumeError.state }
        let expected = try HandshakeCrypto.binderS(psk: ticket.psk, ticketId: ticket.ticketId,
                                                   ePubS: s.ePubS, serverNonce: s.serverNonce, ePubC: eph.publicKey)
        guard constantTimeEqual(expected, s.binder) else { throw ResumeError.badServerBinder }

        let kx = try CryptoSuite.clientSessionKeys(ePubC: eph.publicKey, eSecC: eph.secretKey, ePubS: s.ePubS)
        let thResume = try HandshakeCrypto.thResume(ticketId: ticket.ticketId, ePubC: eph.publicKey,
                                                    clientNonce: clientNonce, ePubS: s.ePubS, serverNonce: s.serverNonce)
        let thWithKx = try HandshakeCrypto.thWithKx(thResume: thResume, kC2s: kx.tx, kS2c: kx.rx)
        let tk = try HandshakeCrypto.resumeTrafficKeys(psk: ticket.psk, thWithKx: thWithKx)

        // encTicket is sealed under the DEDICATED K_resume_ticket (NOT K_s2c_final), AAD=∅ (§2.3).
        let ticketKey = try HandshakeCrypto.resumeTicketKey(psk: ticket.psk, thWithKx: thWithKx)
        let ticketPlain = try CryptoSuite.aeadOpen(key: ticketKey, npub: Nonce.make(epoch: 0, dir: .s2c, seq: 0),
                                                   aad: Data(), ciphertext: s.encTicket)
        let newTicket = try ResumptionTicket(fromWire: ticketPlain)

        let session = SessionState(kC2sFinal: tk.c2s, kS2cFinal: tk.s2c, sessionTH: thWithKx,
                                   room: room, clientId: clientId, isResumed: true)
        return ResumeResult(session: session, newTicket: newTicket)
    }

    private func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }
    private func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}
