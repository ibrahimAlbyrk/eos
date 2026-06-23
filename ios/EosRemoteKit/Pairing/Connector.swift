import Foundation

// The SINGLE connect path (connection v2 §5), used byte-identically on first
// connect and every reconnect. The only delta is the msg-1 payload (a one-time
// enrollment token vs the steady marker) — there is no pair/connect/resume split.
//
// Choreography over a live WSConnection (relay mode):
//   1. join (type=0x03, cleartext) presenting the relay-admission value
//      (relayDeviceId for steady, enrollToken for enrollment) → join-ack carries clientId
//   2. Noise_IK msg-1 (version-prefixed, type=0x01 data envelope, cleartext)
//   3. either Noise_IK msg-2 (version-prefixed) → live session, OR a cleartext
//      {t:"error",code:"AUTH_REJECTED"} when the device is genuinely de-enrolled
public final class Connector: Sendable {
    public enum Mode: Sendable {
        case steady
        case enroll(token: String, label: String)
    }

    // Exactly two non-success outcomes (§6): authRejected → NEEDS_PAIRING;
    // anything else is transient → bounded backoff.
    public enum ConnectError: Error {
        case authRejected   // Mac de-enrolled this device, or relay BEARER_DENIED
        case transient(String)
    }

    public struct ConnectResult: Sendable { public let session: SessionState }

    private static let hsWireVersion: UInt8 = 0x02

    private let connection: WSConnection
    private let mode: Mode
    private let deviceStatic: NoiseDH.Keypair
    private let macStaticPub: Data
    private let roomBytes: Data
    private let joinBearer: String
    private let log: @Sendable (String) -> Void

    public init(connection: WSConnection, mode: Mode, deviceStatic: NoiseDH.Keypair,
                macStaticPub: Data, room: String, log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.connection = connection
        self.mode = mode
        self.deviceStatic = deviceStatic
        self.macStaticPub = macStaticPub
        self.roomBytes = Bytes.ascii(room)
        switch mode {
        case .steady: self.joinBearer = NoiseIdentity.relayDeviceId(deviceStatic.pub)
        case .enroll(let token, _): self.joinBearer = token
        }
        self.log = log
    }

    public func run() async throws -> ConnectResult {
        await connection.openForHandshake()
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
            // Not in the allowlist = de-enrolled; Mac offline / room gone = transient.
            throw code == "BEARER_DENIED" ? ConnectError.authRejected : ConnectError.transient("relay \(code)")
        }
        guard ackEnv.type == .relayctl,
              let ack = try? JSONDecoder().decode(JoinAck.self, from: ackEnv.payload),
              ack.t == "joined", let clientId = Bytes.fromB64u(ack.clientId), clientId.count == 16
        else { throw ConnectError.transient("bad join-ack") }
        log("join-ack ok")

        // 2. Noise msg-1.
        let payload1: Data
        switch mode {
        case .steady: payload1 = NoiseIdentity.steadyPayload
        case .enroll(let token, let label): payload1 = NoiseIdentity.buildEnrollPayload(token: token, label: label)
        }
        let initiator = NoiseInitiator(deviceStatic: deviceStatic, macStaticPub: macStaticPub)
        let msg1 = try initiator.writeMessage1(payload1)
        try await connection.sendEnvelopeRaw(Envelope(type: .data, dir: .c2s, epoch: 0, seq: 0,
                                                      room: roomBytes, clientId: clientId,
                                                      payload: Data([Self.hsWireVersion]) + msg1))
        log("msg-1 sent (\(payload1.first == UInt8(ascii: "E") ? "enroll" : "steady"))")

        // 3. msg-2 OR auth-rejected.
        let msg2Env: Envelope
        do { msg2Env = try await connection.receiveEnvelopeRaw() }
        catch { throw ConnectError.transient("msg-2: \(error)") }

        if msg2Env.type == .error {
            throw ConnectError.transient("relay error mid-handshake")
        }
        let body = msg2Env.payload
        // A cleartext AUTH_REJECTED JSON starts with '{'; a Noise msg-2 starts with the version byte.
        if body.first == UInt8(ascii: "{") {
            let code = (try? JSONDecoder().decode(RelayErr.self, from: body))?.code ?? "UNKNOWN"
            log("auth rejected: \(code)")
            throw ConnectError.authRejected
        }
        guard body.count > 1, body.first == Self.hsWireVersion else { throw ConnectError.transient("bad msg-2") }
        let r2: (payload2: Data, keys: NoiseSplitKeys)
        do { r2 = try initiator.readMessage2(body.suffix(from: body.startIndex + 1)) }
        catch { throw ConnectError.transient("msg-2 decrypt failed") }

        let session = SessionState(
            kC2sFinal: r2.keys.kC2sFinal, kS2cFinal: r2.keys.kS2cFinal,
            sessionTH: r2.keys.sessionTH, room: roomBytes, clientId: clientId,
            epoch: 0, isResumed: false)
        await connection.attach(session: session)
        await connection.beginLiveLoop()
        log("session live")
        return ConnectResult(session: session)
    }

    private struct JoinAck: Codable { let t: String; let room: String; let clientId: String }
    private struct RelayErr: Codable { let t: String?; let code: String; let message: String? }
}
