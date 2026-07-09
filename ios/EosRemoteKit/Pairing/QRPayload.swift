import Foundation

// Pairing QR payload v3 (§2). The whole credential is (relay, room, bearer): a relay endpoint, the
// ≥32-byte room capability, and the optional room-join bearer presented in the relay `join`. There
// is no pinned static key and no enrollment token — the bearer IS the join credential. Relay-only:
// there is no LAN transport in v3, so `relay` is required.
public struct QRPayload: Codable, Sendable {
    public let v: Int
    public let typ: String
    public let relay: String            // wss://… public relay endpoint (required)
    public let room: String             // b64url(>=32 bytes) — room capability + routing key
    public let bearer: String?          // b64url(>=32 bytes) — room-join capability (present by default)
    public let exp: Double              // unix seconds — QR display-window close (UX guard)

    public enum QRError: Error { case badType, expired }

    // enforceExpiry defaults true (production fails-closed on a stale screenshot). exp is a UX guard
    // only — the room/bearer stay valid until the daemon re-arms, so a test harness may disable it.
    public static func decode(_ json: Data, now: Double, enforceExpiry: Bool = true) throws -> QRPayload {
        let p = try JSONDecoder().decode(QRPayload.self, from: json)
        guard p.typ == "eos-pair", p.v == 3 else { throw QRError.badType }
        guard p.room.count >= 43 else { throw QRError.badType }   // ≥32 bytes b64url floor
        if let b = p.bearer, b.count < 43 { throw QRError.badType }
        if enforceExpiry { guard p.exp > now else { throw QRError.expired } }
        return p
    }

    public var relayURL: URL? { URL(string: relay) }
}
