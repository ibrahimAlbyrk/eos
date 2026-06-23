import Foundation

// Drives the warm RESUME choreography over a fresh relay WSConnection (§2.3), wiring the
// fixture-proven ResumeDriver crypto to the on-wire framing:
//   1. join (type=0x03, durable bearer) → join-ack (type=0x04) carries a fresh clientId
//   2. RES-1 as a type=0x01 envelope whose payload is the cleartext resume JSON (binder + ephemeral)
//   3. resume-ok (type=0x01) carries ePubS/nS/binder + the rotated ticket sealed under K_resume_ticket
//   4. live loop starts (read + low-risk caps; high-risk needs a fresh cold connect, §2.3)
// No P-256 signature, no Face ID — that is the whole point of resume.
public final class ResumeCoordinator: Sendable {
    public struct ResumeResult: Sendable {
        public let session: SessionState
        public let newTicket: ResumptionTicket
    }
    public enum ResumeError: Error { case badJoinAck, badResumeOk, denied(String) }

    private let connection: WSConnection
    private let ticket: ResumptionTicket
    private let roomBytes: Data
    private let durableBearer: String
    private let log: @Sendable (String) -> Void

    public init(connection: WSConnection, ticket: ResumptionTicket, room: String,
                durableBearer: String, log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.connection = connection; self.ticket = ticket
        self.roomBytes = Bytes.ascii(room); self.durableBearer = durableBearer; self.log = log
    }

    public func run() async throws -> ResumeResult {
        await connection.openForHandshake()
        log("ws opened (resume)")

        // 1. join — durable bearer, clientId is 16 zero bytes until the relay assigns one.
        let zeroId = Data(count: 16)
        let joinJSON = try JSONSerialization.data(withJSONObject: [
            "t": "join", "room": String(decoding: roomBytes, as: UTF8.self), "bearer": durableBearer,
        ])
        try await connection.sendEnvelopeRaw(Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: zeroId, payload: joinJSON))
        let ackEnv = try await connection.receiveEnvelopeRaw()
        if ackEnv.type == .error {
            let code = (try? JSONDecoder().decode(RelayError.self, from: ackEnv.payload))?.code ?? "UNKNOWN"
            throw ResumeError.denied("relay \(code)")
        }
        guard ackEnv.type == .relayctl,
              let ack = try? JSONDecoder().decode(JoinAck.self, from: ackEnv.payload),
              ack.t == "joined", let clientId = Bytes.fromB64u(ack.clientId), clientId.count == 16
        else { throw ResumeError.badJoinAck }
        log("join-ack ok, clientId assigned")

        // 2. RES-1 (cleartext resume frame in a type=0x01 envelope).
        let driver = ResumeDriver(ticket: ticket, clientId: clientId, room: roomBytes)
        try await sendCleartext(driver.buildResume1(), clientId: clientId)
        log("RES-1 sent")

        // 3. resume-ok → derive the live session + open the rotated ticket. The daemon returns a
        // cleartext error envelope (type=0x06) when the ticket is unknown/expired/binder-bad.
        let okEnv = try await connection.receiveEnvelopeRaw()
        if okEnv.type == .error {
            let code = (try? JSONDecoder().decode(RelayError.self, from: okEnv.payload))?.code ?? "UNKNOWN"
            throw ResumeError.denied(code)
        }
        let s = try parseResumeOk(okEnv.payload)
        let result = try driver.processResumeOk(s)
        log("resume-ok verified (binder + rotated ticket)")

        // 4. attach + go live.
        await connection.attach(session: result.session)
        await connection.beginLiveLoop()
        return ResumeResult(session: result.session, newTicket: result.newTicket)
    }

    private func sendCleartext(_ obj: [String: Any], clientId: Data) async throws {
        let json = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        try await connection.sendEnvelopeRaw(Envelope(type: .data, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: clientId, payload: json))
    }

    private func parseResumeOk(_ payload: Data) throws -> ResumeDriver.ServerResume {
        let f = try JSONDecoder().decode(ResumeOk.self, from: payload)
        guard let ePubS = Bytes.fromB64u(f.ePubS), let nS = Bytes.fromB64u(f.nS),
              let binder = Bytes.fromB64u(f.binder), let encTicket = Bytes.fromB64u(f.encTicket)
        else { throw ResumeError.badResumeOk }
        return ResumeDriver.ServerResume(ePubS: ePubS, serverNonce: nS, binder: binder, encTicket: encTicket)
    }

    private struct JoinAck: Codable { let t: String; let room: String; let clientId: String }
    private struct ResumeOk: Codable { let ePubS: String; let nS: String; let binder: String; let encTicket: String }
    private struct RelayError: Codable { let t: String; let code: String; let message: String? }
}
