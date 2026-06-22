import Foundation
import CryptoKit
import LocalAuthentication

// The device static identity I_dev (§1.2). On a real device this is a non-exportable
// Secure-Enclave P-256 key with a biometry ACL — signing triggers Face/Touch ID, which is the
// cold-handshake and step-up biometric. The Simulator has NO Secure Enclave, so a DEBUG-only
// software P-256 key stands in (#if targetEnvironment(simulator)) to make the full
// handshake/AEAD/resume/step-up loop E2E-testable. The software path NEVER compiles into release.
public protocol DeviceIdentity {
    // 65-byte SEC1 (0x04‖X‖Y) public key for the wire / enrollment.
    var publicKeySEC1: Data { get }
    // 64-byte raw r‖s ECDSA-P256-SHA256 signature over the raw message. May prompt biometrics.
    func sign(_ message: Data, reason: String) throws -> Data
}

public enum DeviceIdentityError: Error { case unavailable, signFailed, notFound }

public final class SecureEnclaveDeviceIdentity: DeviceIdentity {
    private let key: SecureEnclave.P256.Signing.PrivateKey

    public init(key: SecureEnclave.P256.Signing.PrivateKey) {
        self.key = key
    }

    // Create a fresh SE key bound to .privateKeyUsage + .biometryCurrentSet (§1.2). Caller persists
    // `key.dataRepresentation` in the Keychain (WhenUnlockedThisDeviceOnly).
    public static func create() throws -> SecureEnclaveDeviceIdentity {
        guard SecureEnclave.isAvailable else { throw DeviceIdentityError.unavailable }
        let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
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
        let ctx = LAContext()
        ctx.localizedReason = reason
        let sig = try key.signature(for: message)
        return sig.rawRepresentation
    }
}

#if DEBUG
// Software P-256 fallback for the Simulator / unit tests ONLY. No biometric gate, no Enclave.
public final class SoftwareDeviceIdentity: DeviceIdentity {
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
