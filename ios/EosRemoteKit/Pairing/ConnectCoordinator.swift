import Foundation

// Drives the cold CONNECT choreography (§2.2) — the post-enrollment re-auth path: an already
// enrolled device proves the SAME Secure-Enclave key over a fresh transcript signature (no Face ID;
// the key has no biometric ACL), WITHOUT a QR. Used after relaunch when the in-memory resume ticket
// is gone/expired/rejected but the device is still in the daemon's ~/.eos/devices allowlist.
//
// Framing mirrors PAIR exactly (join → CONNECT-1/2/3 → sealed welcome), with two differences:
//   • join rides the DURABLE per-device bearer (already on the relay allowlist), not the QR bearer
//   • CONNECT-3 carries NO ots proof (mode == .connect); the daemon authenticates by allowlist
// The sealed welcome (correlationId "pair") returns a freshly rotated durable bearer + ticket.
public final class ConnectCoordinator: Sendable {
    public struct ConnectResult: Sendable {
        public let session: SessionState
        public let durableBearer: String
        public let ticket: ResumptionTicket
    }
    public enum ConnectError: Error { case badJoinAck, badServerHello, badWelcome, denied(String) }

    private let connection: WSConnection
    private let qr: QRPayload                 // synthetic: only macPub (pin) is read in CONNECT
    private let identity: DeviceIdentity
    private let roomBytes: Data
    private let durableBearer: String
    private let devId: String
    private let label: String
    private let log: @Sendable (String) -> Void

    // macPubB64u is the durable Mac identity key pinned at pairing time (persisted in the Keychain).
    public init(connection: WSConnection, macPubB64u: String, room: String, identity: DeviceIdentity,
                devId: String, label: String, durableBearer: String,
                log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.connection = connection
        self.qr = QRPayload(v: 1, typ: "eos-pair", macPub: macPubB64u, ots: "", otsExp: 0,
                            lan: [], lanSpki: nil, relay: nil, bearer: nil, exp: 0)
        self.identity = identity
        self.roomBytes = Bytes.ascii(room); self.durableBearer = durableBearer
        self.devId = devId; self.label = label; self.log = log
    }

    public func run() async throws -> ConnectResult {
        await connection.openForHandshake()
        log("ws opened (connect)")

        // 1. join — durable bearer; clientId is 16 zero bytes until the relay assigns one.
        let zeroId = Data(count: 16)
        let joinJSON = try JSONSerialization.data(withJSONObject: [
            "t": "join", "room": String(decoding: roomBytes, as: UTF8.self), "bearer": durableBearer,
        ])
        try await connection.sendEnvelopeRaw(Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: zeroId, payload: joinJSON))
        let ackEnv = try await connection.receiveEnvelopeRaw()
        if ackEnv.type == .error {
            let code = (try? JSONDecoder().decode(RelayError.self, from: ackEnv.payload))?.code ?? "UNKNOWN"
            throw ConnectError.denied("relay \(code)")
        }
        guard ackEnv.type == .relayctl,
              let ack = try? JSONDecoder().decode(JoinAck.self, from: ackEnv.payload),
              ack.t == "joined", let clientId = Bytes.fromB64u(ack.clientId), clientId.count == 16
        else { throw ConnectError.badJoinAck }
        log("join-ack ok, clientId assigned")

        // 2. CONNECT-1 (cleartext hs in a type=0x01 envelope).
        let driver = HandshakeDriver(mode: .connect, qr: qr, identity: identity, clientId: clientId, room: roomBytes)
        try await sendCleartextHs(driver.buildHello(), clientId: clientId)
        log("CONNECT-1 sent")

        // CONNECT-2 — verify the Mac against the pinned key.
        let s2Env = try await connection.receiveEnvelopeRaw()
        if s2Env.type == .error {
            let code = (try? JSONDecoder().decode(RelayError.self, from: s2Env.payload))?.code ?? "UNKNOWN"
            throw ConnectError.denied(code)
        }
        let s2 = try parseServerHello(s2Env.payload)
        _ = try driver.processServerHello(s2)
        log("CONNECT-2 verified (pin + Mac sig)")

        // 3. CONNECT-3 — SE transcript signature (no Face ID, no ots); derive + attach the live session.
        let auth = try driver.buildClientAuth(serverHello: s2, devId: devId, label: label,
                                              reason: "Reconnect to Eos")
        await connection.attach(session: auth.session)
        try await sendCleartextHs(auth.frame, clientId: clientId)
        log("CONNECT-3 sent, session derived")

        // 4. welcome — SEALED (s2c seq0), correlationId "pair" (shared with the PAIR welcome).
        let welcomeEnv = try await connection.receiveEnvelopeRaw()
        if welcomeEnv.type == .error {
            let code = (try? JSONDecoder().decode(RelayError.self, from: welcomeEnv.payload))?.code ?? "UNKNOWN"
            throw ConnectError.denied(code)
        }
        let plaintext = try auth.session.openIncoming(welcomeEnv)
        guard case .reply(let reply) = try ServerFrame.decode(plaintext), reply.correlationId == "pair",
              let bearer = reply.body?["bearer"]?.stringValue,
              let ticket = parseTicket(reply.body?["ticket"]) else { throw ConnectError.badWelcome }

        await connection.beginLiveLoop()
        return ConnectResult(session: auth.session, durableBearer: bearer, ticket: ticket)
    }

    private func sendCleartextHs(_ obj: [String: Any], clientId: Data) async throws {
        let json = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        try await connection.sendEnvelopeRaw(Envelope(type: .data, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: clientId, payload: json))
    }

    private func parseServerHello(_ payload: Data) throws -> HandshakeDriver.ServerHello {
        let f = try JSONDecoder().decode(Pair2.self, from: payload)
        guard let ePubS = Bytes.fromB64u(f.ePubS), let nS = Bytes.fromB64u(f.nS), let encS = Bytes.fromB64u(f.encS)
        else { throw ConnectError.badServerHello }
        return HandshakeDriver.ServerHello(ePubS: ePubS, serverNonce: nS, encS: encS)
    }

    private func parseTicket(_ v: JSONValue?) -> ResumptionTicket? {
        guard let t = v,
              let tid = t["ticketId"]?.stringValue.flatMap(Bytes.fromB64u),
              let psk = t["psk"]?.stringValue.flatMap(Bytes.fromB64u) else { return nil }
        return ResumptionTicket(ticketId: tid, psk: psk,
                                idleExp: t["idleExp"]?.doubleValue ?? 0,
                                absExp: t["absExp"]?.doubleValue ?? 0)
    }

    private struct JoinAck: Codable { let t: String; let room: String; let clientId: String }
    private struct Pair2: Codable { let ePubS: String; let nS: String; let encS: String }
    private struct RelayError: Codable { let t: String; let code: String; let message: String? }
}
