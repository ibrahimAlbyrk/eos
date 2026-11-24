import Foundation
import EosRemoteKit

// The share extension's own short link to one paired Mac: the same relay join the app makes, with
// the device's room and bearer from the shared Keychain group, so the Mac's access tier for that
// phone applies to every read and start. It sends no push token: the app keeps that up to date.
actor ShareLink {
    /// How long the join may take before the Mac counts as away.
    private static let joinMs: UInt64 = 8_000
    private static let controlMs: UInt64 = 10_000

    private let connection: WSConnection
    private let device: Device

    private init(device: Device, url: URL) {
        self.device = device
        connection = WSConnection(url: url, room: device.room, bearer: device.bearer ?? "")
    }

    /// The live link, or nil when the Mac or the relay did not answer in time.
    static func open(_ device: Device) async -> ShareLink? {
        guard let url = device.relayURL else { return nil }
        let link = ShareLink(device: device, url: url)
        return await link.join() ? link : nil
    }

    private func join() async -> Bool {
        let connection = self.connection
        let connector = Connector(connection: connection, room: device.room, bearer: device.bearer ?? "", push: nil)
        // A silent relay is cut off by closing the socket, as the app's supervisor does.
        let deadline = Task {
            try? await Task.sleep(nanoseconds: Self.joinMs * 1_000_000)
            if !Task.isCancelled { await connection.close() }
        }
        defer { deadline.cancel() }
        return (try? await connector.run()) != nil
    }

    /// A control and its answer whatever its status; nil when the Mac could not be asked.
    func call(_ method: String, _ path: String, _ body: JSONValue) async -> (Int, JSONValue?)? {
        let data = (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
        guard let reply = try? await connection.sendControlAnswer(method: method, path: path, bodyData: data,
                                                                  timeoutMs: Self.controlMs)
        else { return nil }
        return (reply.status, reply.body)
    }

    func close() async {
        await connection.close()
    }
}
