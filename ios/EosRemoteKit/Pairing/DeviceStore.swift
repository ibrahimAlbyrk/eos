import Foundation

// Persists the LIST of paired Macs (Phase 5a). Split storage, mirroring the single-device design:
//   • secrets (room + bearer) live in the Keychain, one item per device keyed by id — same
//     accessibility as before (AfterFirstUnlockThisDeviceOnly, no biometric ACL) so background /
//     post-reboot resume can read them.
//   • non-secret metadata (id, label, relayUrl, lastActive) + the active id live in UserDefaults as
//     a small JSON index. The relay URL is not a secret (it rides the QR and the relay logs anyway).
//
// On first launch after the multi-device change, `migrateLegacyIfNeeded()` folds the old three
// standalone Keychain items (relay.url / relay.room / relay.bearer) into one Device so existing
// users never re-pair.
public final class DeviceStore: @unchecked Sendable {
    // Per-device Keychain secret (room + bearer) as a JSON blob, keyed by "device.secret.<id>".
    private struct Secret: Codable { let room: String; let bearer: String? }

    // The persisted metadata index (UserDefaults).
    private struct Index: Codable {
        var devices: [Metadata]
        var activeId: String?
    }
    private struct Metadata: Codable {
        let id: String
        var label: String
        var relayUrl: String
        var lastActive: Double
    }

    private let defaults: UserDefaults
    private let secrets: SecretStore
    // Reader for the LEGACY three standalone Keychain items (relay.url/room/bearer), used only by
    // migration. Injectable so a test process (no Keychain entitlement) can seed + read them.
    private let legacyGet: @Sendable (String) -> Data?
    private let indexKey = "dev.eos.remote.devices.index"

    public init(defaults: UserDefaults = .standard,
                secrets: SecretStore = KeychainSecretStore(),
                legacyGet: @escaping @Sendable (String) -> Data? = { KeychainStore.get($0) }) {
        self.defaults = defaults
        self.secrets = secrets
        self.legacyGet = legacyGet
    }

    // MARK: public API

    // The paired devices, most-recently-active first (stable by id on ties).
    public func load() -> [Device] {
        let index = readIndex()
        return index.devices
            .compactMap { meta -> Device? in
                guard let secret = readSecret(meta.id) else { return nil }   // orphaned metadata → skip
                return Device(id: meta.id, label: meta.label, relayUrl: meta.relayUrl,
                              room: secret.room, bearer: secret.bearer, lastActive: meta.lastActive)
            }
            .sorted { $0.lastActive == $1.lastActive ? $0.id < $1.id : $0.lastActive > $1.lastActive }
    }

    public func activeId() -> String? { readIndex().activeId }

    public func setActiveId(_ id: String?) {
        var index = readIndex()
        // Only accept an id we actually have (or nil to clear).
        if let id, !index.devices.contains(where: { $0.id == id }) { return }
        index.activeId = id
        writeIndex(index)
    }

    // Insert or update a device (creds → Keychain, metadata → index). New devices append; if there
    // is no active device yet, the first added becomes active.
    public func upsert(_ device: Device) {
        writeSecret(device.id, Secret(room: device.room, bearer: device.bearer))
        var index = readIndex()
        let meta = Metadata(id: device.id, label: device.label,
                            relayUrl: device.relayUrl, lastActive: device.lastActive)
        if let i = index.devices.firstIndex(where: { $0.id == device.id }) {
            index.devices[i] = meta
        } else {
            index.devices.append(meta)
        }
        if index.activeId == nil { index.activeId = device.id }
        writeIndex(index)
    }

    // Bump lastActive for list ordering (called when a device connects). No-op if unknown.
    public func touch(_ id: String, at ts: Double = Date().timeIntervalSince1970) {
        var index = readIndex()
        guard let i = index.devices.firstIndex(where: { $0.id == id }) else { return }
        index.devices[i].lastActive = ts
        writeIndex(index)
    }

    // Remove a device: wipe its secret + drop its metadata. If it was active, fall back to the
    // most-recently-active remaining device (or clear when none remain). Returns the new active id.
    @discardableResult
    public func remove(_ id: String) -> String? {
        deleteSecret(id)
        var index = readIndex()
        index.devices.removeAll { $0.id == id }
        if index.activeId == id {
            index.activeId = index.devices
                .sorted { $0.lastActive == $1.lastActive ? $0.id < $1.id : $0.lastActive > $1.lastActive }
                .first?.id
        }
        writeIndex(index)
        return index.activeId
    }

    // MARK: legacy migration (§2 of the task)

    // First launch after multi-device: if the old standalone creds exist and we have no device list
    // yet, wrap them into one Device and set it active. Idempotent — once the index has devices (or
    // the legacy items are gone) this is a no-op. The legacy Keychain items are left in place (repo
    // rule: don't delete user data by hand); they are simply no longer read after migration.
    @discardableResult
    public func migrateLegacyIfNeeded() -> Device? {
        guard readIndex().devices.isEmpty else { return nil }   // already migrated / has devices
        guard let relayData = legacyGet(KeychainStore.relayURL),
              let relay = String(data: relayData, encoding: .utf8),
              let roomData = legacyGet(KeychainStore.room),
              let room = String(data: roomData, encoding: .utf8), !room.isEmpty
        else { return nil }
        let bearer = legacyGet(KeychainStore.bearer).flatMap { String(data: $0, encoding: .utf8) }
        let device = Device(id: Device.newId(), label: Device.label(fromRelay: relay),
                            relayUrl: relay, room: room, bearer: bearer,
                            lastActive: Date().timeIntervalSince1970)
        upsert(device)
        setActiveId(device.id)
        return device
    }

    // MARK: index (UserDefaults)

    private func readIndex() -> Index {
        guard let data = defaults.data(forKey: indexKey),
              let index = try? JSONDecoder().decode(Index.self, from: data)
        else { return Index(devices: [], activeId: nil) }
        return index
    }

    private func writeIndex(_ index: Index) {
        guard let data = try? JSONEncoder().encode(index) else { return }
        defaults.set(data, forKey: indexKey)
    }

    // MARK: secrets (Keychain)

    private func secretKey(_ id: String) -> String { "device.secret.\(id)" }

    private func writeSecret(_ id: String, _ secret: Secret) {
        guard let data = try? JSONEncoder().encode(secret) else { return }
        secrets.set(secretKey(id), data)
    }

    private func readSecret(_ id: String) -> Secret? {
        guard let data = secrets.get(secretKey(id)) else { return nil }
        return try? JSONDecoder().decode(Secret.self, from: data)
    }

    private func deleteSecret(_ id: String) { secrets.delete(secretKey(id)) }
}
