import Foundation
import Security

// Durable secret storage (§8). The entire credential is the room capability: the relay URL, the
// ≥32-byte room id, and the room-join bearer — exactly three items. Accessibility is
// AfterFirstUnlockThisDeviceOnly (NOT WhenUnlocked) and carries NO biometric ACL, so a reconnect
// triggered right after a reboot, or in the background, can read them once the user has unlocked
// once — the property that makes "open the app → connected, every time" true.
public enum KeychainStore {
    public enum KeychainError: Error { case status(OSStatus) }

    private static let service = "dev.eos.remote"

    public static func set(_ key: String, _ value: Data) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = value
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    public static func get(_ key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    public static func delete(_ key: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ] as CFDictionary)
    }

    // Well-known item keys (§8) — the three room-capability values.
    public static let relayURL = "relay.url"     // wss://relay…/ from the QR
    public static let room = "relay.room"        // b64url ≥32-byte room capability
    public static let bearer = "relay.bearer"    // b64url room-join capability
}
