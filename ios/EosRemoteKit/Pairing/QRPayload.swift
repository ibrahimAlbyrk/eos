import Foundation

// Pairing QR payload (§6). Decoded from the scanned JSON. macPub is the PINNED Mac identity the
// device asserts equality on in PAIR-2; ots is single-use/short-lived; lanSpki pins the LAN leg.
public struct QRPayload: Codable, Sendable {
    public let v: Int
    public let typ: String
    public let macPub: String           // b64u SEC1 65B
    public let ots: String              // b64u 32B one-time pairing secret
    public let otsExp: Double
    public let lan: [String]            // wss URLs
    public let lanSpki: String?         // b64 SHA-256(DER SPKI) of the LAN self-signed cert
    public let relay: Relay?
    public let bearer: String?          // b64u 32B one-time pairing bearer
    public let exp: Double

    public struct Relay: Codable, Sendable { public let url: String; public let room: String }

    public enum QRError: Error { case badType, expired, missingTransport }

    public static func decode(_ json: Data, now: Double) throws -> QRPayload {
        let p = try JSONDecoder().decode(QRPayload.self, from: json)
        guard p.typ == "eos-pair", p.v == 1 else { throw QRError.badType }
        guard p.exp > now, p.otsExp > now else { throw QRError.expired }
        guard p.relay != nil || !p.lan.isEmpty else { throw QRError.missingTransport }
        return p
    }

    public var macPubData: Data? { Bytes.fromB64u(macPub) }
    public var otsData: Data? { Bytes.fromB64u(ots) }
    public var bearerData: Data? { bearer.flatMap(Bytes.fromB64u) }
    public var lanSpkiData: Data? { lanSpki.flatMap { Data(base64Encoded: $0) } }
}
