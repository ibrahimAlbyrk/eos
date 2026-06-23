import Foundation

// The device's long-term X25519 static keypair — the ENTIRE device credential
// (connection v2 §3.1). A plain 32-byte secret in the Keychain
// (AfterFirstUnlockThisDeviceOnly, no biometric ACL), so it survives app-close and
// phone-restart and is readable on a background/post-reboot reconnect. No Secure
// Enclave, no P-256, no biometric — WireGuard's model.
public enum DeviceStatic {
    // Load the persisted static keypair, or generate + persist one on first use.
    public static func loadOrCreate() throws -> NoiseDH.Keypair {
        if let sec = KeychainStore.get(KeychainStore.deviceStaticSec), sec.count == 32 {
            return NoiseDH.Keypair(pub: NoiseDH.pub(sec), sec: sec)
        }
        let kp = NoiseDH.keypair()
        try KeychainStore.set(KeychainStore.deviceStaticSec, kp.sec)
        return kp
    }

    // The current keypair if one is enrolled, else nil (no generation).
    public static func existing() -> NoiseDH.Keypair? {
        guard let sec = KeychainStore.get(KeychainStore.deviceStaticSec), sec.count == 32 else { return nil }
        return NoiseDH.Keypair(pub: NoiseDH.pub(sec), sec: sec)
    }

    public static func relayDeviceId() -> String? {
        guard let kp = existing() else { return nil }
        return NoiseIdentity.relayDeviceId(kp.pub)
    }
}
