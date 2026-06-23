import Foundation
import Security

// Durable secret storage (connection v2). The entire device credential is a single
// X25519 static secret; alongside it sit the pinned Mac static public key and the
// relay coordinates. Accessibility is AfterFirstUnlockThisDeviceOnly (NOT
// WhenUnlocked) and carries NO biometric ACL, so a reconnect triggered right after
// a reboot, or in the background, can read the key once the user has unlocked once
// — the property that makes "open the app → connected, every time" true (§3.1).
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

    // Well-known item keys (connection v2).
    public static let deviceStaticSec = "device.static.sec" // 32-byte X25519 secret — the whole credential
    public static let macStaticPub = "mac.static.pub"       // 32-byte pinned Mac static public key (from the QR)
    public static let relayURL = "relay.url"
    public static let room = "relay.room"
}
