import Foundation
import Security

// Durable secret storage (§8). The entire credential is the room capability: the relay URL, the
// ≥32-byte room id, and the room-join bearer — exactly three items. Accessibility is
// AfterFirstUnlockThisDeviceOnly (NOT WhenUnlocked) and carries NO biometric ACL, so a reconnect
// triggered right after a reboot, or in the background, can read them once the user has unlocked
// once — the property that makes "open the app → connected, every time" true.
// Items are written to the App Group's access group so the share extension can join the room too
// (07 §4.8); a build signed without the App Group keeps them in the app's own group. Reads and
// deletes name no group, so they reach the item wherever an older build wrote it.
public enum KeychainStore {
    public enum KeychainError: Error { case status(OSStatus) }

    private static let service = "dev.eos.remote"
    /// The access group the app and its share extension share: the App Group itself.
    public static let accessGroup = EosCache.appGroup

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
        var shared = add
        shared[kSecAttrAccessGroup as String] = accessGroup
        var status = SecItemAdd(shared as CFDictionary, nil)
        if status == errSecMissingEntitlement { status = SecItemAdd(add as CFDictionary, nil) }
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
