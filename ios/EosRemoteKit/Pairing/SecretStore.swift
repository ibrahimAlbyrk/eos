import Foundation

// Per-device secret backend. Production stores each device's (room + bearer) blob in the Keychain
// keyed by id (same accessibility as the single-device creds). Abstracted so a test process — which
// has no keychain-access-group entitlement and cannot write the real Keychain — can inject an
// in-memory backend and still exercise DeviceStore end-to-end.
public protocol SecretStore: Sendable {
    func set(_ key: String, _ value: Data)
    func get(_ key: String) -> Data?
    func delete(_ key: String)
}

// The default: the app's Keychain (dev.eos.remote service, AfterFirstUnlockThisDeviceOnly).
public struct KeychainSecretStore: SecretStore {
    public init() {}
    public func set(_ key: String, _ value: Data) { try? KeychainStore.set(key, value) }
    public func get(_ key: String) -> Data? { KeychainStore.get(key) }
    public func delete(_ key: String) { KeychainStore.delete(key) }
}

// In-memory backend for tests (no entitlement required). Not used in the app.
public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    public init() {}
    public func set(_ key: String, _ value: Data) { lock.lock(); items[key] = value; lock.unlock() }
    public func get(_ key: String) -> Data? { lock.lock(); defer { lock.unlock() }; return items[key] }
    public func delete(_ key: String) { lock.lock(); items[key] = nil; lock.unlock() }
}
