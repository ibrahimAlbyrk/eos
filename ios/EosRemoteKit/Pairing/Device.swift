import Foundation

// A paired Mac (Phase 5a). The whole credential is still the room capability (relay, room, bearer);
// a Device just names one and gives it a stable id so the app can hold several at once. `id` is a
// random b64url token minted at pair time (NOT derived from the creds, so re-pairing the same Mac to
// a rotated room keeps the row's identity stable if the caller reuses the id).
public struct Device: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public var label: String
    public var relayUrl: String
    public var room: String
    public var bearer: String?
    public var lastActive: Double   // unix seconds; bumped on connect for ordering the list

    public init(id: String, label: String, relayUrl: String, room: String,
                bearer: String?, lastActive: Double = 0) {
        self.id = id
        self.label = label
        self.relayUrl = relayUrl
        self.room = room
        self.bearer = bearer
        self.lastActive = lastActive
    }

    public var relayURL: URL? { URL(string: relayUrl) }

    // A fresh 16-byte b64url id for a newly paired device.
    public static func newId() -> String { Bytes.b64u(RandomBytes.make(16)) }

    // Presentation label from a relay endpoint's host ("wss://mac.example.com/" → "mac"), or "Mac".
    public static func label(fromRelay relay: String) -> String {
        guard let host = URL(string: relay)?.host, !host.isEmpty else { return "Mac" }
        // A bare hostname reads better than the FQDN: "mba.local" → "mba".
        return host.split(separator: ".").first.map(String.init) ?? host
    }
}

// CSPRNG bytes (§0: SecRandomCopyBytes) for the device id. Kept here — the crypto suite was deleted.
enum RandomBytes {
    static func make(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        if status == errSecSuccess { return Data(bytes) }
        // SecRandom failing is effectively impossible; fall back to UUID entropy rather than trap.
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max) })
    }
}
