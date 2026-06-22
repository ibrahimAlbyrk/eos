import Foundation

public enum Direction: UInt8, Sendable {
    case c2s = 0x00 // device → Mac
    case s2c = 0x01 // Mac → device
}

// 24-byte structured AEAD nonce (§1.5): epoch(1) ‖ dir(1) ‖ seq(8 BE) ‖ 0x00 × 14.
public enum Nonce {
    public static func make(epoch: UInt8, dir: Direction, seq: UInt64) -> Data {
        var n = Data(count: 24)
        n[0] = epoch
        n[1] = dir.rawValue
        var be = seq.bigEndian
        withUnsafeBytes(of: &be) { raw in
            for i in 0..<8 { n[2 + i] = raw[i] }
        }
        return n
    }
}
