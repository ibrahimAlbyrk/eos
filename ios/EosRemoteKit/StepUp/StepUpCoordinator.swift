import Foundation

// Builds the step-up field for a high-risk control (§7.3). The caller has already obtained a
// fresh `challenge` frame (control POST /stepup/challenge → challengeNonce). Here we hash the
// EXACT body bytes, build stepUpMsg bound to this session's sessionTH, and SE-sign (Face ID).
public final class StepUpCoordinator {
    private let identity: DeviceIdentity
    private let session: SessionState

    public enum StepUpError: Error { case resumedSessionCannotStepUp }

    public init(identity: DeviceIdentity, session: SessionState) {
        self.identity = identity; self.session = session
    }

    // bodyBytes MUST be the identical bytes that travel in the control frame (no re-serialization, §3.4).
    public func field(method: String, path: String, bodyBytes: Data, challengeNonce: Data, ts: Int64,
                      reason: String) throws -> StepUpField {
        // A resumed (ticket) session has no Enclave key → can't satisfy step-up; surface early.
        if session.isResumed { throw StepUpError.resumedSessionCannotStepUp }
        let bodyHash = try HandshakeCrypto.bodyHash(bodyBytes)
        let msg = StepUp.message(sessionTH: session.sessionTH, method: method, path: path,
                                 bodyHash: bodyHash, challengeNonce: challengeNonce, ts: ts)
        let sig = try identity.sign(msg, reason: reason)
        return StepUpField(challengeNonce: Bytes.b64u(challengeNonce), ts: ts, sig: Bytes.b64u(sig))
    }
}
