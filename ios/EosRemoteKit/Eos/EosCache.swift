import Foundation

// What the Eos tab last read from one paired Mac (07 §4.8): its routines, its Needs you and when it
// was read, so the tab and the share extension show something while the Mac is away. One file per
// Mac in the App Group container (the share extension reads it too), protected until the phone's
// first unlock after a restart.
public struct EosSnapshot: Codable, Sendable, Equatable {
    public var routines: [EosRoutine]
    public var inbox: [EosInboxItem]
    /// When it was read from the Mac (unix seconds).
    public var seenAt: Double

    public init(routines: [EosRoutine] = [], inbox: [EosInboxItem] = [], seenAt: Double = 0) {
        self.routines = routines; self.inbox = inbox; self.seenAt = seenAt
    }
}

public final class EosCache: @unchecked Sendable {
    /// The App Group the app and its share extension share.
    public static let appGroup = "group.dev.eos.remote"

    private let dir: URL

    public init(dir: URL) {
        self.dir = dir
    }

    /// The shared container; this app's own support folder when the group is not there (a build
    /// signed without the App Group).
    public static func shared() -> EosCache {
        EosCache(dir: sharedDir())
    }

    /// Where the app and its share extension keep what they share about each Mac.
    public static func sharedDir() -> URL {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        let base = group ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("eos", isDirectory: true)
    }

    public func load(device: String) -> EosSnapshot? {
        guard let data = try? Data(contentsOf: file(device)) else { return nil }
        return try? JSONDecoder().decode(EosSnapshot.self, from: data)
    }

    public func save(_ snapshot: EosSnapshot, device: String) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: file(device), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func remove(device: String) {
        try? FileManager.default.removeItem(at: file(device))
    }

    private func file(_ device: String) -> URL {
        // A device id is b64url: safe as a file name.
        dir.appendingPathComponent("mac-\(device).json")
    }
}
