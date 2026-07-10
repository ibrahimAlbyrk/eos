import Foundation

// Inner frames (§5): a `data` envelope's payload is exactly one plaintext UTF-8 JSON object, tagged
// by `t`. In v3 there is no AEAD and no handshake frame family (no `hs`/`resume`/`challenge`) — the
// relay join is the only handshake; every server frame below is plaintext.

public enum ServerFrame {
    case event(EventFrame)
    case patch(PatchFrame)
    case snapshot(SnapshotFrame)
    case reply(ReplyFrame)
    case asset(AssetFrame)
    case ka(ts: Double)
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
        case "asset":     return .asset(try d.decode(AssetFrame.self, from: data))
        case "ka":        return .ka(ts: (try? d.decode(KaFrame.self, from: data).ts) ?? 0)
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

// Binary route read (§5.4.5, contract AssetFrameSchema — FROZEN shape): a non-JSON response
// (/fs/image, /fs/raw, /pdfjs) rides base64 out-of-band instead of the JSON `reply` frame.
public struct AssetFrame: Codable, Sendable {
    public let t: String
    public let correlationId: String
    public let status: Int
    public let mime: String
    public let bytesB64: String
}

public struct ErrorFrame: Codable, Sendable {
    public let t: String
    public let code: String             // §5.5 error-code enum
    public let message: String?
    public let correlationId: String?
}

// client → server frames.
public struct HelloFrame: Codable, Sendable {
    public var t = "hello"
    public var lastContentId: Int?
}

public struct ControlFrame: Codable, Sendable {
    public var t = "control"
    public var correlationId: String
    public var method: String
    public var path: String
    // OPAQUE JSON string (contract `body: string`, §5.2.3): the request body serialized exactly
    // ONCE and carried verbatim so the daemon dispatches the exact transmitted bytes.
    public var body: String

    public init(correlationId: String, method: String, path: String, body: String) {
        self.correlationId = correlationId; self.method = method; self.path = path; self.body = body
    }
}
