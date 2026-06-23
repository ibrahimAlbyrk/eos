import Foundation

// Stable device identity + Noise msg-1 payload format (connection v2). Mirror of
// the daemon's manager/remote/identity.ts.
//
//   relayDeviceId = b64u(BLAKE2b-256(deviceStaticPub))  — derived, never rotates.
//   msg-1 payload (language-agnostic text, NOT JSON, so bytes are reproducible):
//     steady : "S"
//     enroll : "E" ‖ <enrollTokenB64u> ‖ "\n" ‖ <label-utf8>   (label is the tail)
public enum NoiseIdentity {
    public static func relayDeviceId(_ deviceStaticPub: Data) -> String {
        let h = (try? CryptoSuite.genericHash(deviceStaticPub, key: nil, outLen: 32)) ?? Data()
        return Bytes.b64u(h)
    }

    public static let steadyPayload = Data("S".utf8)

    public static func buildEnrollPayload(token: String, label: String) -> Data {
        Data("E\(token)\n\(label)".utf8)
    }
}
