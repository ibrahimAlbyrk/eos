import Foundation

// Live session identity after the relay join (§5, §6). With encryption removed there are no keys,
// no epoch, no replay/gap counters — a session is just the room + the relay-assigned clientId, plus
// two trivial codecs that translate an inner-frame JSON to/from a plaintext `data` envelope.
public final class SessionState: @unchecked Sendable {
    public let room: Data            // ASCII room id bytes
    public var clientId: Data        // 16 bytes, assigned by the relay join-ack

    public init(room: Data, clientId: Data) {
        self.room = room; self.clientId = clientId
    }

    // Wrap an inner-frame JSON into an outer `data` envelope (c2s). epoch/seq are 0 (unvalidated).
    public func frameToEnvelope(_ json: Data) -> Data {
        Envelope(type: .data, dir: .c2s, epoch: 0, seq: 0,
                 room: room, clientId: clientId, payload: json).encode()
    }

    // The inner-frame JSON of an incoming s2c `data` envelope: the payload verbatim, or — a Mac that saw
    // cap "deflate" in our hello — DEFLATE_MARK (0x01) + raw DEFLATE of it. JSON never starts with 0x01.
    public func envelopeToJSON(_ env: Envelope) -> Data {
        guard env.payload.first == SessionState.deflateMark else { return env.payload }
        return SessionState.inflate(env.payload.dropFirst()) ?? Data()
    }

    public static let deflateMark: UInt8 = 0x01

    // Raw DEFLATE (RFC 1951) — what Apple's `.zlib` algorithm reads and Node's deflateRaw writes.
    static func inflate(_ data: Data) -> Data? {
        try? (Data(data) as NSData).decompressed(using: .zlib) as Data
    }
}
