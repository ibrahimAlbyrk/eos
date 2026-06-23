import Foundation
import Security

// Durable secret storage. The device static key blob (SE dataRepresentation), the durable
// bearer + devId, and the resumption ticket {ticketId, PSK} live here as
// WhenUnlockedThisDeviceOnly. The ticket has NO biometric ACL (warm resume = no Face ID, §2.3);
// the SE key's biometric gate lives in the key's own access control, not the item's.
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
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
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

    // Well-known item keys.
    public static let deviceKeyBlob = "device.key.blob"
    public static let durableBearer = "device.bearer"
    public static let devId = "device.id"
    public static let ticket = "resumption.ticket"
    // Relay coordinates needed to reopen the socket for a warm resume after relaunch.
    public static let relayURL = "relay.url"
    public static let room = "relay.room"
}
