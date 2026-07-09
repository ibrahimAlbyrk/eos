import Foundation

// Frame direction on the outer envelope (moved here from the deleted Crypto/Nonce.swift; it is a
// wire field, not a crypto input). c2s = device → Mac, s2c = Mac → device.
public enum Direction: UInt8, Sendable {
    case c2s = 0x00 // device → Mac
    case s2c = 0x01 // Mac → device
}

public enum EnvelopeType: UInt8, Sendable {
    case data = 0x01
    case register = 0x02
    case join = 0x03
    case relayctl = 0x04
    case ka = 0x05
    case error = 0x06
}

// Outer envelope (§4.4): relay-visible, binary, big-endian. One envelope = one WS binary message.
// Byte-identical to the desktop manager/remote/envelope.ts.
//   ver(1) type(1) dir(1) epoch(1) seq(8 BE) roomLen(1) room(R) clientId(16) payload(..)
// For type=data(0x01) the payload is plaintext inner-frame JSON (§5) — no AEAD; epoch/seq are set
// to 0 and never validated (they lost their crypto role in v3).
public struct Envelope: Sendable {
    public static let version: UInt8 = 0x01
    public static let maxSize = 5 * 1024 * 1024

    public var type: EnvelopeType
    public var dir: Direction
    public var epoch: UInt8
    public var seq: UInt64
    public var room: Data        // ASCII bytes (b64u room id, 22 chars in v1)
    public var clientId: Data    // 16 bytes; all-zero for register / Mac broadcasts
    public var payload: Data

    public init(type: EnvelopeType, dir: Direction, epoch: UInt8, seq: UInt64,
                room: Data, clientId: Data, payload: Data) {
        self.type = type; self.dir = dir; self.epoch = epoch; self.seq = seq
        self.room = room; self.clientId = clientId; self.payload = payload
    }

    public enum EnvelopeError: Error { case tooShort, badVersion, badType, tooLarge }

    public func encode() -> Data {
        var out = Data()
        out.append(Envelope.version)
        out.append(type.rawValue)
        out.append(dir.rawValue)
        out.append(epoch)
        var beSeq = seq.bigEndian
        withUnsafeBytes(of: &beSeq) { out.append(contentsOf: $0) }
        out.append(UInt8(room.count))
        out.append(room)
        out.append(clientId) // 16 bytes
        out.append(payload)
        return out
    }

    public static func decode(_ data: Data) throws -> Envelope {
        guard data.count >= 13 else { throw EnvelopeError.tooShort }
        guard data.count <= maxSize else { throw EnvelopeError.tooLarge }
        let b = [UInt8](data)
        guard b[0] == version else { throw EnvelopeError.badVersion }
        guard let type = EnvelopeType(rawValue: b[1]) else { throw EnvelopeError.badType }
        guard let dir = Direction(rawValue: b[2]) else { throw EnvelopeError.badType }
        let epoch = b[3]
        var seq: UInt64 = 0
        for i in 0..<8 { seq = (seq << 8) | UInt64(b[4 + i]) }
        let roomLen = Int(b[12])
        let roomStart = 13
        let clientIdStart = roomStart + roomLen
        guard data.count >= clientIdStart + 16 else { throw EnvelopeError.tooShort }
        let room = data.subdata(in: roomStart..<clientIdStart)
        let clientId = data.subdata(in: clientIdStart..<(clientIdStart + 16))
        let payload = data.subdata(in: (clientIdStart + 16)..<data.count)
        return Envelope(type: type, dir: dir, epoch: epoch, seq: seq,
                        room: room, clientId: clientId, payload: payload)
    }
}
