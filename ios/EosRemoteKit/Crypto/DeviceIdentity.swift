import Foundation
import CryptoKit

// The device static identity I_dev (§1.2). On a real device this is a non-exportable
// Secure-Enclave P-256 key. It has NO biometric ACL: signing is usable whenever the device is
// unlocked, with no Face/Touch ID prompt — so cold connect / step-up reconnect silently. The
// Simulator has NO Secure Enclave, so a DEBUG-only software P-256 key stands in
// (#if targetEnvironment(simulator)) to make the full handshake/AEAD/resume/step-up loop
// E2E-testable. The software path NEVER compiles into release.
public protocol DeviceIdentity: Sendable {
    // 65-byte SEC1 (0x04‖X‖Y) public key for the wire / enrollment.
    var publicKeySEC1: Data { get }
    // 64-byte raw r‖s ECDSA-P256-SHA256 signature over the raw message. `reason` is retained for
    // call-site clarity but no longer drives a biometric prompt.
    func sign(_ message: Data, reason: String) throws -> Data
}

public enum DeviceIdentityError: Error { case unavailable, signFailed, notFound }

public final class SecureEnclaveDeviceIdentity: DeviceIdentity, @unchecked Sendable {
    private let key: SecureEnclave.P256.Signing.PrivateKey

    public init(key: SecureEnclave.P256.Signing.PrivateKey) {
        self.key = key
    }

    // Create a fresh SE key bound to .privateKeyUsage only — NO biometric flag (§1.2). The key is
    // usable without any Face/Touch ID prompt while the device is unlocked; access is gated solely
    // by the WhenUnlockedThisDeviceOnly accessibility on the persisted `key.dataRepresentation`.
    public static func create() throws -> SecureEnclaveDeviceIdentity {
        guard SecureEnclave.isAvailable else { throw DeviceIdentityError.unavailable }
        let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage],
            nil)
        guard let access else { throw DeviceIdentityError.signFailed }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        return SecureEnclaveDeviceIdentity(key: key)
    }

    public static func restore(dataRepresentation: Data) throws -> SecureEnclaveDeviceIdentity {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation)
        return SecureEnclaveDeviceIdentity(key: key)
    }

    public var dataRepresentation: Data { key.dataRepresentation }
    public var publicKeySEC1: Data { key.publicKey.x963Representation }

    public func sign(_ message: Data, reason: String) throws -> Data {
        let sig = try key.signature(for: message)
        return sig.rawRepresentation
    }
}

#if DEBUG
// Software P-256 fallback for the Simulator / unit tests ONLY. No biometric gate, no Enclave.
public final class SoftwareDeviceIdentity: DeviceIdentity, @unchecked Sendable {
    private let key: P256.Signing.PrivateKey

    public init(key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) {
        self.key = key
    }

    public var dataRepresentation: Data { key.rawRepresentation }
    public var publicKeySEC1: Data { key.publicKey.x963Representation }

    public func sign(_ message: Data, reason: String) throws -> Data {
        try key.signature(for: message).rawRepresentation
    }
}
#endif

public enum DeviceIdentityFactory {
    // Returns the SE identity on-device; the software fallback under the Simulator (DEBUG only).
    public static func create() throws -> DeviceIdentity {
        #if targetEnvironment(simulator)
        #if DEBUG
        return SoftwareDeviceIdentity()
        #else
        throw DeviceIdentityError.unavailable
        #endif
        #else
        return try SecureEnclaveDeviceIdentity.create()
        #endif
    }
}
