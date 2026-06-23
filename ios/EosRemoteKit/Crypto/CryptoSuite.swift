import Foundation
import Clibsodium

// The libsodium half of the suite (protocol §1.3–§1.5): crypto_kx, keyed/unkeyed BLAKE2b,
// and XChaCha20-Poly1305-IETF via the EXPLICIT-nonce C call. swift-sodium's high-level
// auto-nonce AEAD wrapper is FORBIDDEN (§1.5) — our nonce is deterministic and lives in the
// outer header, so every call here goes straight to Clibsodium's C functions.
public enum CryptoSuite {
    public enum CryptoError: Error { case initFailed, kx, aead, decrypt }

    private static let initialized: Bool = { sodium_init() >= 0 }()

    public static func ensureInit() throws {
        if !initialized { throw CryptoError.initFailed }
    }

    public struct SessionKeys {
        public let rx: Data // device receives on this key = K_s2c (Mac→device)
        public let tx: Data // device sends on this key   = K_c2s (device→Mac)
    }

    public struct KxKeypair { public let publicKey: Data; public let secretKey: Data }

    // Per-session ephemeral X25519 keypair (software, destroyed at session end → forward secrecy).
    public static func generateKxKeypair() throws -> KxKeypair {
        try ensureInit()
        var pk = [UInt8](repeating: 0, count: 32)
        var sk = [UInt8](repeating: 0, count: 32)
        guard crypto_kx_keypair(&pk, &sk) == 0 else { throw CryptoError.kx }
        return KxKeypair(publicKey: Data(pk), secretKey: Data(sk))
    }

    // Device is always CLIENT (§1.3). K_c2s = tx_c, K_s2c = rx_c.
    public static func clientSessionKeys(ePubC: Data, eSecC: Data, ePubS: Data) throws -> SessionKeys {
        try ensureInit()
        precondition(ePubC.count == 32 && eSecC.count == 32 && ePubS.count == 32)
        var rx = [UInt8](repeating: 0, count: 32)
        var tx = [UInt8](repeating: 0, count: 32)
        let rc = ePubC.withUnsafeBytes { cpk in
            eSecC.withUnsafeBytes { csk in
                ePubS.withUnsafeBytes { spk in
                    crypto_kx_client_session_keys(
                        &rx, &tx,
                        cpk.bindMemory(to: UInt8.self).baseAddress!,
                        csk.bindMemory(to: UInt8.self).baseAddress!,
                        spk.bindMemory(to: UInt8.self).baseAddress!)
                }
            }
        }
        guard rc == 0 else { throw CryptoError.kx }
        return SessionKeys(rx: Data(rx), tx: Data(tx))
    }

    // crypto_generichash (BLAKE2b). key == nil → unkeyed (transcript hash); key set → keyed (KDF, binders, otsProof).
    public static func genericHash(_ message: Data, key: Data? = nil, outLen: Int = 32) throws -> Data {
        try ensureInit()
        var out = [UInt8](repeating: 0, count: outLen)
        let rc: Int32 = message.withUnsafeBytes { msg -> Int32 in
            let mPtr = msg.bindMemory(to: UInt8.self).baseAddress
            let mLen = UInt64(message.count)
            if let key = key {
                return key.withUnsafeBytes { k in
                    crypto_generichash(&out, outLen, mPtr, mLen,
                                       k.bindMemory(to: UInt8.self).baseAddress, key.count)
                }
            } else {
                return crypto_generichash(&out, outLen, mPtr, mLen, nil, 0)
            }
        }
        guard rc == 0 else { throw CryptoError.aead }
        return Data(out)
    }

    // KDF(key, label, transcriptHash) = keyed-BLAKE2b over (label ‖ TH) under `key` (§1.4).
    public static func kdf(key: Data, label: String, transcriptHash: Data) throws -> Data {
        try genericHash(Bytes.ascii(label) + transcriptHash, key: key, outLen: 32)
    }

    private static let npubBytes = 24

    // XChaCha20-Poly1305-IETF combined mode → output is `ciphertext ‖ tag16` (§1.5).
    public static func aeadSeal(key: Data, npub: Data, aad: Data, plaintext: Data) throws -> Data {
        try ensureInit()
        precondition(key.count == 32 && npub.count == npubBytes)
        var c = [UInt8](repeating: 0, count: plaintext.count + 16)
        var clen: UInt64 = 0
        let rc: Int32 = plaintext.withUnsafeBytes { m in
            aad.withUnsafeBytes { ad in
                npub.withUnsafeBytes { n in
                    key.withUnsafeBytes { k in
                        crypto_aead_xchacha20poly1305_ietf_encrypt(
                            &c, &clen,
                            m.bindMemory(to: UInt8.self).baseAddress, UInt64(plaintext.count),
                            ad.bindMemory(to: UInt8.self).baseAddress, UInt64(aad.count),
                            nil,
                            n.bindMemory(to: UInt8.self).baseAddress!,
                            k.bindMemory(to: UInt8.self).baseAddress!)
                    }
                }
            }
        }
        guard rc == 0 else { throw CryptoError.aead }
        return Data(c.prefix(Int(clen)))
    }

    public static func aeadOpen(key: Data, npub: Data, aad: Data, ciphertext: Data) throws -> Data {
        try ensureInit()
        precondition(key.count == 32 && npub.count == npubBytes)
        guard ciphertext.count >= 16 else { throw CryptoError.decrypt }
        var m = [UInt8](repeating: 0, count: ciphertext.count - 16)
        var mlen: UInt64 = 0
        let rc: Int32 = ciphertext.withUnsafeBytes { c in
            aad.withUnsafeBytes { ad in
                npub.withUnsafeBytes { n in
                    key.withUnsafeBytes { k in
                        crypto_aead_xchacha20poly1305_ietf_decrypt(
                            &m, &mlen, nil,
                            c.bindMemory(to: UInt8.self).baseAddress!, UInt64(ciphertext.count),
                            ad.bindMemory(to: UInt8.self).baseAddress, UInt64(aad.count),
                            n.bindMemory(to: UInt8.self).baseAddress!,
                            k.bindMemory(to: UInt8.self).baseAddress!)
                    }
                }
            }
        }
        guard rc == 0 else { throw CryptoError.decrypt }
        return Data(m.prefix(Int(mlen)))
    }
}
