import Foundation

// High-risk control step-up signed message (§3.2). Line separators are the single byte 0x0A,
// never CRLF (§13.2). sessionTH binds the signature to this exact live session (TH3 for a cold
// session, TH_with_kx for a resumed one) so a captured sig can't be transplanted.
public enum StepUp {
    public static func message(sessionTH: Data, method: String, path: String, bodyHash: Data,
                               challengeNonce: Data, ts: Int64) -> Data {
        let parts: [String] = [
            "eos/v1 stepup",
            Bytes.hex(sessionTH),
            method,
            path,
            Bytes.hex(bodyHash),
            Bytes.b64u(challengeNonce),
            String(ts),
        ]
        return Bytes.ascii(parts.joined(separator: "\n"))
    }
}
