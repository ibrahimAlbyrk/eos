import Foundation

// What the app restores across launches (round 7): the Code-list filter chip, the open
// conversation, and the drawer section. Drawer open/closed is deliberately NOT here — the app
// always relaunches with the drawer closed (platform convention).
public struct RestorableUIState: Codable, Equatable, Sendable {
    public var filter: String?
    public var openWorkerId: String?
    public var section: String?

    public init(filter: String? = nil, openWorkerId: String? = nil, section: String? = nil) {
        self.filter = filter
        self.openWorkerId = openWorkerId
        self.section = section
    }
}

// Persists RestorableUIState keyed BY DEVICE ID — a small JSON index in UserDefaults, mirroring
// the DeviceStore metadata index (nothing here is secret). Scoping per device keeps Mac A's open
// worker from being pushed while Mac B is active. Callers write on every change (not on scene
// exit) so a crash restores the same as a clean quit.
public final class UIStateStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let indexKey = "dev.eos.remote.uistate.index"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // Unknown or nil device (nothing paired yet) reads as the empty state.
    public func state(for deviceId: String?) -> RestorableUIState {
        guard let deviceId else { return RestorableUIState() }
        return readIndex()[deviceId] ?? RestorableUIState()
    }

    // Read-modify-write of one device's slot; a nil device id has no slot to write.
    public func update(for deviceId: String?, _ mutate: (inout RestorableUIState) -> Void) {
        guard let deviceId else { return }
        var index = readIndex()
        var state = index[deviceId] ?? RestorableUIState()
        mutate(&state)
        index[deviceId] = state
        writeIndex(index)
    }

    // Wipe every device's slot — UITests launch with -eosResetUIState so each test starts from
    // the Code-list root instead of whatever the previous test left open.
    public func clearAll() {
        defaults.removeObject(forKey: indexKey)
    }

    private func readIndex() -> [String: RestorableUIState] {
        guard let data = defaults.data(forKey: indexKey),
              let index = try? JSONDecoder().decode([String: RestorableUIState].self, from: data)
        else { return [:] }
        return index
    }

    private func writeIndex(_ index: [String: RestorableUIState]) {
        guard let data = try? JSONEncoder().encode(index) else { return }
        defaults.set(data, forKey: indexKey)
    }
}

// The stale-id fallback decision (round 7), plain logic so it's unit-testable: a restored
// conversation stays open until the device is connected AND its first workers list has resolved;
// from then on the id must exist live or archived, else the conversation pops silently.
public enum UIRestore {
    public static func shouldClose(openId: String, connected: Bool, workersLoaded: Bool,
                                   workerIds: [String], archivedIds: [String]) -> Bool {
        connected && workersLoaded && !workerIds.contains(openId) && !archivedIds.contains(openId)
    }
}
