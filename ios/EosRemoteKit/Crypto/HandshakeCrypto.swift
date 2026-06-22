import Foundation

// The transcript-bound key schedule for the three handshakes (§2). Pure derivations over
// CryptoSuite; no I/O, no state — every value here is checked against the golden fixture.
public enum HandshakeCrypto {
    // Labels are load-bearing exact ASCII (§13.2). One typo silently breaks interop.
    enum Label {
        static let hsS2c = "eos/v1 hs s2c"
        static let hsC2s = "eos/v1 hs c2s"
        static let pairServer = "eos/v1 pair server"
        static let pairClient = "eos/v1 pair client"
        static let connServer = "eos/v1 conn server"
        static let connClient = "eos/v1 conn client"
        static let dataC2s = "eos/v1 data c2s"
        static let dataS2c = "eos/v1 data s2c"
        static let resumeBinderC = "eos/v1 resume binderC"
        static let resumeBinderS = "eos/v1 resume binderS"
        static let resumeDataC2s = "eos/v1 resume data c2s"
        static let resumeDataS2c = "eos/v1 resume data s2c"
        static let resumeTicket = "eos/v1 resume ticket"
        static let stepup = "eos/v1 stepup"
    }

    // TH2 = BLAKE2b(ePub_c ‖ clientNonce ‖ ePub_s ‖ serverNonce), unkeyed (§2.1 ②).
    public static func th2(ePubC: Data, clientNonce: Data, ePubS: Data, serverNonce: Data) throws -> Data {
        try CryptoSuite.genericHash(ePubC + clientNonce + ePubS + serverNonce)
    }

    // TH3 = BLAKE2b(ePub_c ‖ clientNonce ‖ ePub_s ‖ serverNonce ‖ encS), unkeyed (§2.1 ⑤).
    public static func th3(ePubC: Data, clientNonce: Data, ePubS: Data, serverNonce: Data, encS: Data) throws -> Data {
        try CryptoSuite.genericHash(ePubC + clientNonce + ePubS + serverNonce + encS)
    }

    public static func hsKeyS2c(kS2c: Data, th2: Data) throws -> Data {
        try CryptoSuite.kdf(key: kS2c, label: Label.hsS2c, transcriptHash: th2)
    }

    public static func hsKeyC2s(kC2s: Data, th3: Data) throws -> Data {
        try CryptoSuite.kdf(key: kC2s, label: Label.hsC2s, transcriptHash: th3)
    }

    // otsProof = keyed-BLAKE2b(message = TH3, key = ots) (§2.1 ⑥).
    public static func otsProof(th3: Data, ots: Data) throws -> Data {
        try CryptoSuite.genericHash(th3, key: ots)
    }

    public struct TrafficKeys { public let c2s: Data; public let s2c: Data }

    // Post-cold-handshake traffic keys over TH3 (§2.5).
    public static func trafficKeys(kC2s: Data, kS2c: Data, th3: Data) throws -> TrafficKeys {
        TrafficKeys(
            c2s: try CryptoSuite.kdf(key: kC2s, label: Label.dataC2s, transcriptHash: th3),
            s2c: try CryptoSuite.kdf(key: kS2c, label: Label.dataS2c, transcriptHash: th3))
    }

    // --- RESUME (§2.3) ---

    public static func thResume(ticketId: Data, ePubC: Data, clientNonce: Data, ePubS: Data, serverNonce: Data) throws -> Data {
        try CryptoSuite.genericHash(ticketId + ePubC + clientNonce + ePubS + serverNonce)
    }

    public static func thWithKx(thResume: Data, kC2s: Data, kS2c: Data) throws -> Data {
        try CryptoSuite.genericHash(thResume + kC2s + kS2c)
    }

    public static func binderC(psk: Data, ticketId: Data, ePubC: Data, clientNonce: Data) throws -> Data {
        try CryptoSuite.genericHash(Bytes.ascii(Label.resumeBinderC) + ticketId + ePubC + clientNonce, key: psk)
    }

    public static func binderS(psk: Data, ticketId: Data, ePubS: Data, serverNonce: Data, ePubC: Data) throws -> Data {
        try CryptoSuite.genericHash(Bytes.ascii(Label.resumeBinderS) + ticketId + ePubS + serverNonce + ePubC, key: psk)
    }

    public static func resumeTrafficKeys(psk: Data, thWithKx: Data) throws -> TrafficKeys {
        TrafficKeys(
            c2s: try CryptoSuite.kdf(key: psk, label: Label.resumeDataC2s, transcriptHash: thWithKx),
            s2c: try CryptoSuite.kdf(key: psk, label: Label.resumeDataS2c, transcriptHash: thWithKx))
    }

    // DEDICATED key sealing the resume encTicket ONLY (§2.3) — keeps the ticket out of the
    // K_s2c_final (key, nonce) space, so an empty AAD on encTicket is safe.
    public static func resumeTicketKey(psk: Data, thWithKx: Data) throws -> Data {
        try CryptoSuite.kdf(key: psk, label: Label.resumeTicket, transcriptHash: thWithKx)
    }

    // bodyHash for step-up signatures = unkeyed BLAKE2b over the exact transmitted body bytes (§3.4).
    public static func bodyHash(_ bodyBytes: Data) throws -> Data {
        try CryptoSuite.genericHash(bodyBytes)
    }

    // Signed-message prefixes (§3.1) — exposed so the handshake driver and KAT use one source.
    public static func macSigMessage(mode: HandshakeMode, th2: Data) -> Data {
        let label = mode == .connect ? Label.connServer : Label.pairServer
        return Bytes.ascii(label) + th2
    }

    public static func deviceSigMessage(mode: HandshakeMode, th3: Data) -> Data {
        let label = mode == .connect ? Label.connClient : Label.pairClient
        return Bytes.ascii(label) + th3
    }
}

public enum HandshakeMode { case pair, connect }
