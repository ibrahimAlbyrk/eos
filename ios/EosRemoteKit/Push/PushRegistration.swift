import CryptoKit
import Foundation

// Push to this phone (07 §4.6). The relay holds the APNs device token each join sends and, when a
// Mac asks, has Apple wake the phone with a kind and a count only: the text comes from this app's
// own table (`Localizable.strings`, `push.<kind>.title` / `.body`), so nothing a user, an agent or
// a service wrote reaches Apple. The token is no secret, but it is the phone's address: never logged.

/// What a join tells the relay so it can wake this phone.
public struct PushJoin: Equatable, Sendable {
    /// The APNs device token, lower-case hex.
    public let token: String
    /// Which of Apple's push services issued it: `sandbox` or `production`.
    public let env: String

    public init(token: String, env: String) {
        self.token = token
        self.env = env
    }
}

public enum PushState: Equatable, Sendable {
    /// Not asked yet this launch.
    case unknown
    case registered
    /// The user said no to notifications.
    case denied
    /// iOS refused to register: a build signed without the push entitlement (a free or
    /// another team's signing) gets no push.
    case unavailable
}

public final class PushRegistration: @unchecked Sendable {
    public static let shared = PushRegistration(defaults: .standard)

    private static let tokenKey = "push.apnsToken"
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var current: PushState = .unknown

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// The push service this build's entitlement names: a debug build is signed for development
    /// (sandbox); TestFlight and App Store builds use production.
    public static var buildEnv: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    public static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    public var state: PushState {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    /// What every join sends; none until iOS gave a token. A token from an earlier launch is sent
    /// until this launch's registration answers.
    public var join: PushJoin? {
        guard let token = defaults.string(forKey: Self.tokenKey), !token.isEmpty else { return nil }
        return PushJoin(token: token, env: Self.buildEnv)
    }

    public func registered(token: Data) {
        defaults.set(Self.hex(token), forKey: Self.tokenKey)
        set(.registered)
    }

    public func failed() {
        defaults.removeObject(forKey: Self.tokenKey)
        set(.unavailable)
    }

    public func denied() {
        defaults.removeObject(forKey: Self.tokenKey)
        set(.denied)
    }

    /// The line Settings shows when this phone gets no push; none while it does.
    public var settingsLine: String? {
        switch state {
        case .unavailable: return "Push needs the TestFlight app"
        case .denied: return "Notifications are off for Eos in iOS Settings"
        case .unknown, .registered: return nil
        }
    }

    private func set(_ state: PushState) {
        lock.lock(); current = state; lock.unlock()
        NotificationCenter.default.post(name: .eosPushStateChanged, object: nil)
    }
}

public extension Notification.Name {
    static let eosPushStateChanged = Notification.Name("eos.push.stateChanged")
}

// Which paired Mac a push came from: its `m` is the first 8 hex of SHA-256 of the Mac's room id.
public enum PushRouting {
    public static func mark(room: String) -> String {
        let digest = SHA256.hash(data: Data(room.utf8))
        return digest.prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    public static func device(for mark: String?, in devices: [Device]) -> Device? {
        guard let mark, mark.count == 8 else { return nil }
        return devices.first { Self.mark(room: $0.room) == mark.lowercased() }
    }

    /// Where a tap on a push opens: Needs you, of the Mac it came from when that is paired.
    public static func link(for userInfo: [AnyHashable: Any], in devices: [Device]) -> URL? {
        var parts = URLComponents()
        parts.scheme = "eos"
        parts.host = "inbox"
        if let device = device(for: userInfo["m"] as? String, in: devices) {
            parts.queryItems = [URLQueryItem(name: "device", value: device.id)]
        }
        return parts.url
    }
}
