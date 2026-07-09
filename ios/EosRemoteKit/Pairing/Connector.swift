import Foundation

// The SINGLE connect path (§6), used byte-identically on first connect and every reconnect. With
// encryption removed there is no handshake beyond the relay join — "pair", "connect" and "resume"
// are the same three steps:
//   1. open the relay socket
//   2. send relay `join` (type=0x03, plaintext) {t:"join", room, bearer} → await the `joined` ack
//      (type=0x04) carrying the relay-assigned clientId
//   3. attach the session + go live (the phone is immediately live; it may then issue controls)
// The phone MUST NOT send any `data` frame before the join-ack (relay routing needs the clientId).
public final class Connector: Sendable {
    // Exactly two non-success outcomes (§5.4): authRejected → NEEDS_PAIRING; anything else is
    // transient → bounded backoff.
    public enum ConnectError: Error {
        case authRejected   // relay BEARER_DENIED (bearer rotated) → re-pair
        case transient(String)
    }

    public struct ConnectResult: Sendable { public let session: SessionState }

    private let connection: WSConnection
    private let roomBytes: Data
    private let joinBearer: String
    private let log: @Sendable (String) -> Void

    public init(connection: WSConnection, room: String, bearer: String,
                log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.connection = connection
        self.roomBytes = Bytes.ascii(room)
        self.joinBearer = bearer
        self.log = log
    }

    public func run() async throws -> ConnectResult {
        await connection.openForJoin()
        log("ws opened")

        // 1. join — clientId is 16 zero bytes until the relay assigns one.
        let joinJSON = try JSONSerialization.data(withJSONObject: [
            "t": "join", "room": String(decoding: roomBytes, as: UTF8.self), "bearer": joinBearer,
        ])
        try await connection.sendEnvelopeRaw(Envelope(type: .join, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: Data(count: 16), payload: joinJSON))
        let ackEnv: Envelope
        do { ackEnv = try await connection.receiveEnvelopeRaw() }
        catch { throw ConnectError.transient("join-ack: \(error)") }

        if ackEnv.type == .error {
            let code = (try? JSONDecoder().decode(RelayErr.self, from: ackEnv.payload))?.code ?? "UNKNOWN"
            log("relay rejected join: \(code)")
            // Bearer not in the allowlist = rotated/revoked → re-pair. Room missing (daemon offline
            // / restarting) = transient → backoff.
            throw code == "BEARER_DENIED" ? ConnectError.authRejected : ConnectError.transient("relay \(code)")
        }
        guard ackEnv.type == .relayctl,
              let ack = try? JSONDecoder().decode(JoinAck.self, from: ackEnv.payload),
              ack.t == "joined", let clientId = Bytes.fromB64u(ack.clientId), clientId.count == 16
        else { throw ConnectError.transient("bad join-ack") }
        log("join-ack ok")

        // 2. live — no handshake; the session is just room + assigned clientId.
        let session = SessionState(room: roomBytes, clientId: clientId)
        await connection.attach(session: session)
        await connection.beginLiveLoop()
        log("session live")
        return ConnectResult(session: session)
    }

    private struct JoinAck: Codable { let t: String; let room: String?; let clientId: String }
    private struct RelayErr: Codable { let t: String?; let code: String; let message: String? }
}
