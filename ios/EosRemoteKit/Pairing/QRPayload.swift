import Foundation

// Pairing QR payload (connection v2 §5.2). Decoded from the scanned JSON. macStatic is the PINNED
// Mac static X25519 key the device uses as the Noise responder static; enroll is the single-use
// enrollment token (also the relay-admission value during the pairing window). lanSpki pins the LAN
// leg.
public struct QRPayload: Codable, Sendable {
    public let v: Int
    public let typ: String
    public let macStatic: String        // b64u of the Mac static X25519 public key (32B)
    public let enroll: String           // b64u one-time enrollment token
    public let lan: [String]            // wss URLs
    public let lanSpki: String?         // b64 SHA-256(DER SPKI) of the LAN self-signed cert
    public let relay: Relay?
    public let exp: Double              // unix seconds — enrollment window close

    public struct Relay: Codable, Sendable { public let url: String; public let room: String }

    public enum QRError: Error { case badType, expired, missingTransport }

    // enforceExpiry defaults true (production fails-closed on a burned/expired QR). The live E2E
    // harness sets it false so the SERVER (enrollment token) is the sole expiry authority.
    public static func decode(_ json: Data, now: Double, enforceExpiry: Bool = true) throws -> QRPayload {
        let p = try JSONDecoder().decode(QRPayload.self, from: json)
        guard p.typ == "eos-pair", p.v == 2 else { throw QRError.badType }
        if enforceExpiry { guard p.exp > now else { throw QRError.expired } }
        guard p.relay != nil || !p.lan.isEmpty else { throw QRError.missingTransport }
        return p
    }

    public var macStaticData: Data? { Bytes.fromB64u(macStatic) }
    public var lanSpkiData: Data? { lanSpki.flatMap { Data(base64Encoded: $0) } }
}
