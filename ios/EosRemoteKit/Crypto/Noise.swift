import Foundation
import Clibsodium

// Noise_IK_25519_XChaChaPoly_BLAKE2b — the SINGLE handshake for the iOS remote
// edge (connection v2). Byte-for-byte mirror of the daemon's manager/remote/noise.ts;
// the shared golden fixture (docs/vectors/ios-remote-v2/) proves Swift↔Node interop.
//
// IK pattern:
//   <- s                  (responder static pre-known: the Mac static from the QR)
//   -> e, es, s, ss       (msg 1: device → Mac; device static sent encrypted)
//   <- e, ee, se          (msg 2: Mac → device)

public enum NoiseConst {
    public static let protocolName = "Noise_IK_25519_XChaChaPoly_BLAKE2b"
    public static let prologue = "eos-remote-v2"
    public static let dhLen = 32
    public static let hashLen = 32
    public static let tagLen = 16
    static let blake2bBlock = 128
}

// ---- X25519 raw DH (crypto_scalarmult) -------------------------------------

public enum NoiseDH {
    public struct Keypair: Sendable { public let pub: Data; public let sec: Data }

    public static func keypair() -> Keypair {
        var pk = [UInt8](repeating: 0, count: 32)
        var sk = [UInt8](repeating: 0, count: 32)
        _ = crypto_box_keypair(&pk, &sk)
        return Keypair(pub: Data(pk), sec: Data(sk))
    }

    public static func pub(_ sec: Data) -> Data {
        var out = [UInt8](repeating: 0, count: 32)
        sec.withUnsafeBytes { s in
            _ = crypto_scalarmult_base(&out, s.bindMemory(to: UInt8.self).baseAddress!)
        }
        return Data(out)
    }

    public static func dh(_ sec: Data, _ pub: Data) -> Data {
        var out = [UInt8](repeating: 0, count: 32)
        sec.withUnsafeBytes { s in
            pub.withUnsafeBytes { p in
                _ = crypto_scalarmult(&out,
                                      s.bindMemory(to: UInt8.self).baseAddress!,
                                      p.bindMemory(to: UInt8.self).baseAddress!)
            }
        }
        return Data(out)
    }
}

// ---- BLAKE2b-based HMAC + HKDF (Noise §4.3) --------------------------------

enum NoiseKDF {
    static func hash(_ parts: Data...) -> Data {
        var m = Data()
        for p in parts { m.append(p) }
        return (try? CryptoSuite.genericHash(m, key: nil, outLen: NoiseConst.hashLen)) ?? Data()
    }

    static func hmac(_ key: Data, _ data: Data) -> Data {
        var k = key
        if k.count > NoiseConst.blake2bBlock { k = hash(k) }
        var block = [UInt8](repeating: 0, count: NoiseConst.blake2bBlock)
        for (i, b) in k.enumerated() { block[i] = b }
        var ipad = [UInt8](repeating: 0, count: NoiseConst.blake2bBlock)
        var opad = [UInt8](repeating: 0, count: NoiseConst.blake2bBlock)
        for i in 0..<NoiseConst.blake2bBlock {
            ipad[i] = block[i] ^ 0x36
            opad[i] = block[i] ^ 0x5c
        }
        return hash(Data(opad), hash(Data(ipad), data))
    }

    static func hkdf2(_ ck: Data, _ ikm: Data) -> (Data, Data) {
        let tempKey = hmac(ck, ikm)
        let o1 = hmac(tempKey, Data([0x01]))
        let o2 = hmac(tempKey, o1 + Data([0x02]))
        return (o1, o2)
    }
}

// Per-CipherState 64-bit counter n in the LAST 8 bytes of the 24-byte npub (LE).
private func noiseNonce(_ n: UInt64) -> Data {
    var npub = [UInt8](repeating: 0, count: 24)
    var le = n.littleEndian
    withUnsafeBytes(of: &le) { src in
        for i in 0..<8 { npub[16 + i] = src[i] }
    }
    return Data(npub)
}

// ---- CipherState -----------------------------------------------------------

final class NoiseCipherState {
    private var k: Data?
    private var n: UInt64 = 0

    func initializeKey(_ key: Data?) { k = key; n = 0 }

    func encryptWithAd(_ ad: Data, _ plaintext: Data) throws -> Data {
        guard let k = k else { return plaintext }
        let ct = try CryptoSuite.aeadSeal(key: k, npub: noiseNonce(n), aad: ad, plaintext: plaintext)
        n += 1
        return ct
    }

    func decryptWithAd(_ ad: Data, _ ciphertext: Data) throws -> Data {
        guard let k = k else { return ciphertext }
        let pt = try CryptoSuite.aeadOpen(key: k, npub: noiseNonce(n), aad: ad, ciphertext: ciphertext)
        n += 1
        return pt
    }
}

// ---- SymmetricState --------------------------------------------------------

final class NoiseSymmetricState {
    var ck: Data
    var h: Data
    let cs = NoiseCipherState()

    init() {
        let name = Data(NoiseConst.protocolName.utf8)
        if name.count <= NoiseConst.hashLen {
            h = name + Data(repeating: 0, count: NoiseConst.hashLen - name.count)
        } else {
            h = NoiseKDF.hash(name)
        }
        ck = h
    }

    func mixHash(_ data: Data) { h = NoiseKDF.hash(h, data) }

    func mixKey(_ ikm: Data) {
        let (newCk, tempK) = NoiseKDF.hkdf2(ck, ikm)
        ck = newCk
        cs.initializeKey(tempK)
    }

    func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ct = try cs.encryptWithAd(h, plaintext)
        mixHash(ct)
        return ct
    }

    func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let pt = try cs.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return pt
    }

    func split() -> (Data, Data) { NoiseKDF.hkdf2(ck, Data()) }
}

public struct NoiseSplitKeys {
    public let kC2sFinal: Data // device→Mac (initiator send / responder recv)
    public let kS2cFinal: Data // Mac→device (initiator recv / responder send)
    public let sessionTH: Data // final handshake hash h
}

public enum NoiseError: Error { case decryptFailed, badMessage }

// ---- IK initiator (device) -------------------------------------------------

public final class NoiseInitiator {
    private let sym = NoiseSymmetricState()
    private let s: NoiseDH.Keypair      // device static
    private let rs: Data                 // Mac static public (pinned from QR)
    private var e: NoiseDH.Keypair       // device ephemeral
    private var re = Data()              // Mac ephemeral public

    // testEphemeral injected only by the fixture/tests for determinism.
    public init(deviceStatic: NoiseDH.Keypair, macStaticPub: Data, testEphemeral: NoiseDH.Keypair? = nil) {
        s = deviceStatic
        rs = macStaticPub
        e = testEphemeral ?? NoiseDH.keypair()
        sym.mixHash(Data(NoiseConst.prologue.utf8))
        sym.mixHash(rs) // pre-message: responder static
    }

    public func writeMessage1(_ payload1: Data) throws -> Data {
        sym.mixHash(e.pub)
        sym.mixKey(NoiseDH.dh(e.sec, rs))            // es
        let ctS = try sym.encryptAndHash(s.pub)       // s
        sym.mixKey(NoiseDH.dh(s.sec, rs))            // ss
        let ctP = try sym.encryptAndHash(payload1)
        return e.pub + ctS + ctP
    }

    public func readMessage2(_ msg2: Data) throws -> (payload2: Data, keys: NoiseSplitKeys) {
        guard msg2.count >= NoiseConst.dhLen else { throw NoiseError.badMessage }
        re = msg2.prefix(NoiseConst.dhLen)
        sym.mixHash(re)
        sym.mixKey(NoiseDH.dh(e.sec, re))            // ee
        sym.mixKey(NoiseDH.dh(s.sec, re))            // se
        let payload2 = try sym.decryptAndHash(msg2.suffix(from: msg2.startIndex + NoiseConst.dhLen))
        let (k1, k2) = sym.split()
        return (payload2, NoiseSplitKeys(kC2sFinal: k1, kS2cFinal: k2, sessionTH: sym.h))
    }
}

// ---- IK responder (Mac) — used by the fixture test only --------------------

public final class NoiseResponder {
    private let sym = NoiseSymmetricState()
    private let s: NoiseDH.Keypair
    private var e: NoiseDH.Keypair
    private var re = Data()
    private var rsPub = Data()

    public init(macStatic: NoiseDH.Keypair, testEphemeral: NoiseDH.Keypair? = nil) {
        s = macStatic
        e = testEphemeral ?? NoiseDH.keypair()
        sym.mixHash(Data(NoiseConst.prologue.utf8))
        sym.mixHash(s.pub)
    }

    public func readMessage1(_ msg1: Data) throws -> (deviceStaticPub: Data, payload1: Data) {
        guard msg1.count >= NoiseConst.dhLen + NoiseConst.dhLen + NoiseConst.tagLen else { throw NoiseError.badMessage }
        let base = msg1.startIndex
        re = msg1.subdata(in: base ..< base + NoiseConst.dhLen)
        sym.mixHash(re)
        sym.mixKey(NoiseDH.dh(s.sec, re))            // es
        let ctS = msg1.subdata(in: base + NoiseConst.dhLen ..< base + NoiseConst.dhLen + NoiseConst.dhLen + NoiseConst.tagLen)
        rsPub = try sym.decryptAndHash(ctS)
        guard rsPub.count == NoiseConst.dhLen else { throw NoiseError.badMessage }
        sym.mixKey(NoiseDH.dh(s.sec, rsPub))         // ss
        let payload1 = try sym.decryptAndHash(msg1.suffix(from: base + NoiseConst.dhLen + NoiseConst.dhLen + NoiseConst.tagLen))
        return (rsPub, payload1)
    }

    public func writeMessage2(_ payload2: Data) throws -> (msg2: Data, keys: NoiseSplitKeys) {
        sym.mixHash(e.pub)
        sym.mixKey(NoiseDH.dh(e.sec, re))            // ee
        sym.mixKey(NoiseDH.dh(e.sec, rsPub))         // se
        let ctP = try sym.encryptAndHash(payload2)
        let (k1, k2) = sym.split()
        return (e.pub + ctP, NoiseSplitKeys(kC2sFinal: k1, kS2cFinal: k2, sessionTH: sym.h))
    }
}
