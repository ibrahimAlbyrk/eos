import Foundation

// Drives the cold PAIR choreography over a live WSConnection (relay mode), wiring the proven
// HandshakeDriver crypto to the exact on-wire framing daemon-impl pinned:
//   1. join (type=0x03, cleartext JSON, clientId=zero) → join-ack (type=0x04) carries clientId
//   2. PAIR-1/2/3 as type=0x01 envelopes whose payload is the hs JSON IN CLEARTEXT (the encS/encC
//      inside are the only sealed parts; traffic keys don't exist yet)
//   3. a SEALED welcome `reply{correlationId:"pair"}` (s2c seq0) carrying the durable bearer + ticket
//   4. live loop starts; bootstrap current state via READ-tier control GETs
public final class PairingCoordinator: Sendable {
    public struct PairResult: Sendable {
        public let session: SessionState
        public let durableBearer: String
        public let ticket: ResumptionTicket
    }
    public enum PairError: Error { case badJoinAck, badServerHello, badWelcome, denied(String) }

    private let connection: WSConnection
    private let qr: QRPayload
    private let identity: DeviceIdentity
    private let roomBytes: Data
    private let pairBearer: String
    private let devId: String
    private let label: String
    private let log: @Sendable (String) -> Void

    public init(connection: WSConnection, qr: QRPayload, identity: DeviceIdentity,
                room: String, pairBearer: String, devId: String, label: String,
                log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.connection = connection; self.qr = qr; self.identity = identity
        self.roomBytes = Bytes.ascii(room); self.pairBearer = pairBearer
        self.devId = devId; self.label = label; self.log = log
    }

    public func run() async throws -> PairResult {
        await connection.openForHandshake()
        log("ws opened")

        // 1. join — clientId is 16 zero bytes until the relay assigns one.
        let zeroId = Data(count: 16)
        let joinJSON = try JSONSerialization.data(withJSONObject: [
            "t": "join", "room": String(decoding: roomBytes, as: UTF8.self), "bearer": pairBearer,
        ])
        try await connection.sendEnvelopeRaw(Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: zeroId, payload: joinJSON))
        log("join sent")
        let ackEnv = try await connection.receiveEnvelopeRaw()
        log("recv envelope type=\(ackEnv.type.rawValue) dir=\(ackEnv.dir.rawValue) payloadLen=\(ackEnv.payload.count)")
        guard ackEnv.type == .relayctl,
              let ack = try? JSONDecoder().decode(JoinAck.self, from: ackEnv.payload),
              ack.t == "joined", let clientId = Bytes.fromB64u(ack.clientId), clientId.count == 16
        else { throw PairError.badJoinAck }
        log("join-ack ok, clientId assigned")

        // 2. PAIR-1 (cleartext hs in a type=0x01 envelope).
        let driver = HandshakeDriver(mode: .pair, qr: qr, identity: identity, clientId: clientId, room: roomBytes)
        let pair1 = try driver.buildHello()
        try await sendCleartextHs(pair1, clientId: clientId)
        log("PAIR-1 sent")

        // PAIR-2.
        let pair2Env = try await connection.receiveEnvelopeRaw()
        log("PAIR-2 recv type=\(pair2Env.type.rawValue) len=\(pair2Env.payload.count)")
        let s2 = try parseServerHello(pair2Env.payload)
        _ = try driver.processServerHello(s2)
        log("PAIR-2 verified (pin + Mac sig + encS open)")

        // 3. PAIR-3 → derives the live session; attach BEFORE the sealed welcome arrives.
        let auth = try driver.buildClientAuth(serverHello: s2, devId: devId, label: label,
                                              reason: "Pair this device with Eos")
        await connection.attach(session: auth.session)
        try await sendCleartextHs(auth.frame, clientId: clientId)
        log("PAIR-3 sent, session derived")

        // 4. welcome — SEALED (s2c seq0), recognized by correlationId=="pair".
        let welcomeEnv = try await connection.receiveEnvelopeRaw()
        log("welcome recv type=\(welcomeEnv.type.rawValue) len=\(welcomeEnv.payload.count)")
        let plaintext = try auth.session.openIncoming(welcomeEnv)
        guard case .reply(let reply) = try ServerFrame.decode(plaintext), reply.correlationId == "pair",
              let bearer = reply.body?["bearer"]?.stringValue,
              let ticket = parseTicket(reply.body?["ticket"]) else { throw PairError.badWelcome }

        await connection.beginLiveLoop()
        return PairResult(session: auth.session, durableBearer: bearer, ticket: ticket)
    }

    // A cleartext hs frame rides a type=0x01 envelope; payload = the hs JSON UTF-8 (NOT sealed).
    private func sendCleartextHs(_ obj: [String: String], clientId: Data) async throws {
        let json = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        try await connection.sendEnvelopeRaw(Envelope(type: .data, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: clientId, payload: json))
    }

    private func parseServerHello(_ payload: Data) throws -> HandshakeDriver.ServerHello {
        let f = try JSONDecoder().decode(Pair2.self, from: payload)
        guard let ePubS = Bytes.fromB64u(f.ePubS), let nS = Bytes.fromB64u(f.nS), let encS = Bytes.fromB64u(f.encS)
        else { throw PairError.badServerHello }
        return HandshakeDriver.ServerHello(ePubS: ePubS, serverNonce: nS, encS: encS)
    }

    private func parseTicket(_ v: JSONValue?) -> ResumptionTicket? {
        guard let t = v,
              let tid = t["ticketId"]?.stringValue.flatMap(Bytes.fromB64u),
              let psk = t["psk"]?.stringValue.flatMap(Bytes.fromB64u) else { return nil }
        // idleExp/absExp are epoch milliseconds in the daemon's current impl — stored verbatim.
        return ResumptionTicket(ticketId: tid, psk: psk,
                                idleExp: t["idleExp"]?.doubleValue ?? 0,
                                absExp: t["absExp"]?.doubleValue ?? 0)
    }

    private struct JoinAck: Codable { let t: String; let room: String; let clientId: String }
    private struct Pair2: Codable { let ePubS: String; let nS: String; let encS: String }
}
