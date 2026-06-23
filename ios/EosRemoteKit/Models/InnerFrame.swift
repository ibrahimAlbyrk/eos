import Foundation

// Inner frames (§4.2): the AEAD plaintext is exactly one UTF-8 JSON object, tagged by `t`.
// Decoded after open(); encoded before seal(). Handshake `hs`/`resume` frames live separately
// in Pairing/ since they pre-date the traffic keys.

public enum ServerFrame {
    case event(EventFrame)
    case patch(PatchFrame)
    case snapshot(SnapshotFrame)
    case reply(ReplyFrame)
    case ka(ts: Double)
    case challenge(ChallengeFrame)
    case error(ErrorFrame)

    // Single decode entrypoint: peek `t`, then decode the concrete shape.
    public static func decode(_ data: Data) throws -> ServerFrame {
        let tag = try JSONDecoder().decode(TagOnly.self, from: data).t
        let d = JSONDecoder()
        switch tag {
        case "event":     return .event(try d.decode(EventFrame.self, from: data))
        case "patch":     return .patch(try d.decode(PatchFrame.self, from: data))
        case "snapshot":  return .snapshot(try d.decode(SnapshotFrame.self, from: data))
        case "reply":     return .reply(try d.decode(ReplyFrame.self, from: data))
        case "ka":        return .ka(ts: (try? d.decode(KaFrame.self, from: data).ts) ?? 0)
        case "challenge": return .challenge(try d.decode(ChallengeFrame.self, from: data))
        case "error":     return .error(try d.decode(ErrorFrame.self, from: data))
        default: throw FrameError.unknownTag(tag)
        }
    }

    public enum FrameError: Error { case unknownTag(String) }
    private struct TagOnly: Codable { let t: String }
}

public struct KaFrame: Codable, Sendable { public let t: String; public let ts: Double }

public struct EventFrame: Codable, Sendable {
    public let t: String
    public let seq: Int
    public let reason: String      // EventBus topic verbatim (18 topics)
    public let ts: Double?
    public let payload: JSONValue?
}

public struct PatchFrame: Codable, Sendable {
    public let t: String
    public let seq: Int
    public let resource: String    // "workers" | "pending" | ...
    public let op: String          // "upsert" | "remove"
    public let data: JSONValue
}

public struct SnapshotFrame: Codable, Sendable {
    public let t: String
    public let seq: Int
    public let workers: [JSONValue]
    public let pending: [JSONValue]
}

public struct ReplyFrame: Codable, Sendable {
    public let t: String
    public let correlationId: String
    public let status: Int
    public let body: JSONValue?
}

public struct ChallengeFrame: Codable, Sendable {
    public let t: String
    public let challengeNonce: String   // b64u(16)
    public let expiresAt: Double
    public let correlationId: String?   // present when issued as a response to POST /stepup/challenge
}

public struct ErrorFrame: Codable, Sendable {
    public let t: String
    public let code: String             // §7.2 LOCKED enum
    public let message: String?
    public let correlationId: String?
}

// client → server frames.
public struct HelloFrame: Codable, Sendable {
    public var t = "hello"
    public var lastContentId: Int?
    public var resumptionTicket: String?
    public var resumeEphemeralPub: String?
}

public struct ControlFrame: Codable, Sendable {
    public var t = "control"
    public var correlationId: String
    public var method: String
    public var path: String
    // OPAQUE JSON string (contract `body: string`, §3.4): the request body serialized exactly
    // ONCE. bodyHash signs the UTF-8 of THIS string's content; the daemon hashes the decoded
    // string verbatim (no re-serialize), so key-order/number-format can never diverge.
    public var body: String
    public var stepUp: StepUpField?

    public init(correlationId: String, method: String, path: String, body: String, stepUp: StepUpField? = nil) {
        self.correlationId = correlationId; self.method = method; self.path = path
        self.body = body; self.stepUp = stepUp
    }
}

public struct StepUpField: Codable, Sendable {
    public let challengeNonce: String   // b64u(16)
    public let ts: Int64
    public let sig: String              // b64u(64-byte raw r‖s)
    public init(challengeNonce: String, ts: Int64, sig: String) {
        self.challengeNonce = challengeNonce; self.ts = ts; self.sig = sig
    }
}
