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

    // The raw plaintext payload of an incoming s2c `data` envelope — the inner-frame JSON verbatim.
    public func envelopeToJSON(_ env: Envelope) -> Data { env.payload }
}
