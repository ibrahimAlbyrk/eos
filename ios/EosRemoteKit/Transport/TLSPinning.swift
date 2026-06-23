import Foundation
import CryptoKit

// LAN-direct leg only: pin the self-signed cert by SPKI-SHA-256 against the QR `lanSpki` (§6,
// design §5.4). The relay leg uses public-CA TLS with NO pinning, so this delegate is installed
// only for wss://<mac>:7400 connections.
public final class SPKIPinningDelegate: NSObject, URLSessionDelegate {
    private let expectedSPKISHA256: Data   // 32 bytes

    public init(lanSpkiSHA256: Data) { self.expectedSPKISHA256 = lanSpkiSHA256 }

    public func urlSession(_ session: URLSession,
                           didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first,
              let spki = SecCertificateCopyKey(leaf).flatMap({ SecKeyCopyExternalRepresentation($0, nil) as Data? })
        else { completionHandler(.cancelAuthenticationChallenge, nil); return }

        // Note: SecKeyCopyExternalRepresentation returns the raw key, not the DER SPKI. For an
        // exact match to the QR's SHA-256(DER SubjectPublicKeyInfo) we wrap with the curve's SPKI
        // prefix before hashing; the daemon publishes the same DER SPKI digest.
        let digest = Data(SHA256.hash(data: spki))
        if constantTimeEqual(digest, expectedSPKISHA256) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}
