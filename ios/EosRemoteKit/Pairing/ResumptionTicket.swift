import Foundation

// The device side of the resumption ticket (§2.4): the device stores ONLY {ticketId, PSK}
// plus the expiry hints. Capability-bounded to read+low-risk; high-risk always re-steps-up.
public struct ResumptionTicket: Codable, Sendable {
    public let ticketId: Data    // 16 bytes
    public let psk: Data         // 32 bytes
    public let idleExp: Double
    public let absExp: Double

    public init(ticketId: Data, psk: Data, idleExp: Double, absExp: Double) {
        self.ticketId = ticketId; self.psk = psk; self.idleExp = idleExp; self.absExp = absExp
    }

    public func valid(now: Double) -> Bool { now < idleExp && now < absExp }

    public enum TicketError: Error { case badEncoding }

    // Wire shape sent inside encTicket / post-cold-handshake: {ticketId, PSK, idleExp, absExp} (b64u).
    public init(fromWire data: Data) throws {
        let w = try JSONDecoder().decode(Wire.self, from: data)
        guard let tid = Bytes.fromB64u(w.ticketId), let psk = Bytes.fromB64u(w.PSK) else {
            throw TicketError.badEncoding
        }
        self.ticketId = tid; self.psk = psk; self.idleExp = w.idleExp; self.absExp = w.absExp
    }

    private struct Wire: Codable { let ticketId: String; let PSK: String; let idleExp: Double; let absExp: Double }
}
