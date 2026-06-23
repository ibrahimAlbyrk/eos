import Foundation

// Per-session secrets + counters established by a handshake (§2.5). The two directions have
// independent seq counters under epoch 0; sessionTH binds step-up to this exact session (§3.2).
public final class SessionState: @unchecked Sendable {
    public let kC2sFinal: Data       // device → Mac traffic key
    public let kS2cFinal: Data       // Mac → device traffic key
    public let sessionTH: Data       // TH3 (cold) or TH_with_kx (resume)
    public let room: Data            // ASCII room id bytes
    public var clientId: Data        // 16 bytes, assigned by relay/daemon join-ack
    public let epoch: UInt8
    public let isResumed: Bool       // resumed sessions cannot satisfy step-up (no Enclave key)

    private let lock = NSLock()
    private var txSeq: UInt64 = 0     // c2s send counter
    private var rxSeq: UInt64 = 0     // s2c expected-next counter (replay/gap detection)

    public init(kC2sFinal: Data, kS2cFinal: Data, sessionTH: Data, room: Data, clientId: Data,
                epoch: UInt8 = 0, isResumed: Bool) {
        self.kC2sFinal = kC2sFinal; self.kS2cFinal = kS2cFinal; self.sessionTH = sessionTH
        self.room = room; self.clientId = clientId; self.epoch = epoch; self.isResumed = isResumed
    }

    public func nextTxSeq() -> UInt64 { lock.lock(); defer { lock.unlock() }; let s = txSeq; txSeq += 1; return s }

    // Returns false if seq is not strictly increasing (REPLAY) — caller maps to an error.
    public func acceptRxSeq(_ seq: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard seq >= rxSeq else { return false }
        rxSeq = seq + 1
        return true
    }

    // Seal an inner-frame plaintext into an outer `data` envelope (c2s).
    public func sealOutgoing(_ plaintext: Data) throws -> Data {
        let seq = nextTxSeq()
        let aad = Envelope.aad(epoch: epoch, dir: .c2s, seq: seq, room: room, clientId: clientId)
        let npub = Nonce.make(epoch: epoch, dir: .c2s, seq: seq)
        let ct = try CryptoSuite.aeadSeal(key: kC2sFinal, npub: npub, aad: aad, plaintext: plaintext)
        return Envelope(type: .data, dir: .c2s, epoch: epoch, seq: seq,
                        room: room, clientId: clientId, payload: ct).encode()
    }

    // Open an incoming s2c `data` envelope → inner-frame plaintext.
    public func openIncoming(_ env: Envelope) throws -> Data {
        let aad = env.aad()
        let npub = Nonce.make(epoch: env.epoch, dir: .s2c, seq: env.seq)
        return try CryptoSuite.aeadOpen(key: kS2cFinal, npub: npub, aad: aad, ciphertext: env.payload)
    }
}
