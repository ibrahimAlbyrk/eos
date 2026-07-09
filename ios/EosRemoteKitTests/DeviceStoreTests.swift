import XCTest
@testable import EosRemoteKit

// DeviceStore (Phase 5a): the multi-device persistence layer. Storage backends are injected so the
// test runs deterministically in a host-less xctest process (which has no keychain-access-group
// entitlement and cannot write the real Keychain): metadata goes to an isolated UserDefaults suite,
// per-device secrets to an in-memory SecretStore, and the legacy standalone creds to an in-memory
// dict the migration reads. Production wires the same store to the Keychain (KeychainSecretStore).
final class DeviceStoreTests: XCTestCase {

    // A Sendable box for the legacy creds so the @Sendable legacyGet closure captures the box (not
    // the non-Sendable XCTestCase). Backs the in-memory legacy Keychain the migration reads.
    private final class LegacyBox: @unchecked Sendable {
        private var items: [String: Data] = [:]
        private let lock = NSLock()
        subscript(key: String) -> Data? {
            get { lock.lock(); defer { lock.unlock() }; return items[key] }
            set { lock.lock(); items[key] = newValue; lock.unlock() }
        }
    }

    private var suiteName = ""
    private var defaults: UserDefaults!
    private var secrets: InMemorySecretStore!
    private var legacy: LegacyBox!
    private var store: DeviceStore!

    override func setUp() {
        super.setUp()
        suiteName = "DeviceStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        secrets = InMemorySecretStore()
        legacy = LegacyBox()
        store = makeStore()
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // A store over the shared (in-memory) backends — a "fresh instance" for persistence tests still
    // sees the same secrets + defaults, exactly as two app launches share the Keychain + UserDefaults.
    private func makeStore() -> DeviceStore {
        let box = legacy!
        return DeviceStore(defaults: defaults, secrets: secrets, legacyGet: { box[$0] })
    }

    private func makeDevice(label: String = "mac", relay: String = "wss://mac.local/",
                            room: String = "room-1", bearer: String? = "bearer-1",
                            lastActive: Double = 0) -> Device {
        Device(id: Device.newId(), label: label, relayUrl: relay,
               room: room, bearer: bearer, lastActive: lastActive)
    }

    // MARK: add / load

    func testAddAndLoad() {
        let d = makeDevice()
        store.upsert(d)
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.id, d.id)
        XCTAssertEqual(loaded.first?.room, "room-1")
        XCTAssertEqual(loaded.first?.bearer, "bearer-1")
        XCTAssertEqual(loaded.first?.relayUrl, "wss://mac.local/")
    }

    func testFirstAddBecomesActive() {
        let d = makeDevice()
        store.upsert(d)
        XCTAssertEqual(store.activeId(), d.id)
    }

    func testSecretsRoundTripThroughBackend() {
        let d = makeDevice(room: "the-room-secret", bearer: "the-bearer-secret")
        store.upsert(d)
        // A fresh store over the SAME backends must recover the secrets.
        let loaded = makeStore().load()
        XCTAssertEqual(loaded.first?.room, "the-room-secret")
        XCTAssertEqual(loaded.first?.bearer, "the-bearer-secret")
    }

    func testMissingBearerPersists() {
        let d = makeDevice(bearer: nil)
        store.upsert(d)
        XCTAssertNil(store.load().first?.bearer)
    }

    func testOrphanedMetadataIsSkipped() {
        let d = makeDevice()
        store.upsert(d)
        secrets.delete("device.secret.\(d.id)")   // secret vanished, metadata remains
        XCTAssertTrue(store.load().isEmpty)        // load filters it out rather than surfacing a broken device
    }

    // MARK: persist across instances (metadata + ordering)

    func testPersistAcrossInstances() {
        let a = makeDevice(label: "alpha", relay: "wss://a/", room: "ra", lastActive: 100)
        let b = makeDevice(label: "beta", relay: "wss://b/", room: "rb", lastActive: 200)
        store.upsert(a)
        store.upsert(b)
        let fresh = makeStore()
        let loaded = fresh.load()
        XCTAssertEqual(loaded.count, 2)
        // Most-recently-active first.
        XCTAssertEqual(loaded.map(\.id), [b.id, a.id])
        XCTAssertEqual(fresh.activeId(), a.id)   // first added stays active
    }

    func testUpsertUpdatesExisting() {
        var d = makeDevice(label: "old")
        store.upsert(d)
        d.label = "new"
        d.lastActive = 999
        store.upsert(d)
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)          // update, not append
        XCTAssertEqual(loaded.first?.label, "new")
    }

    func testTouchBumpsOrdering() {
        let a = makeDevice(label: "alpha", room: "ra", lastActive: 100)
        let b = makeDevice(label: "beta", room: "rb", lastActive: 200)
        store.upsert(a); store.upsert(b)
        store.touch(a.id, at: 300)               // a is now newest
        XCTAssertEqual(store.load().map(\.id), [a.id, b.id])
    }

    // MARK: remove

    func testRemoveDropsDeviceAndSecret() {
        let d = makeDevice()
        store.upsert(d)
        store.remove(d.id)
        XCTAssertTrue(store.load().isEmpty)
        // Secret is gone from the backend too (a fresh store finds nothing).
        XCTAssertTrue(makeStore().load().isEmpty)
    }

    // MARK: active fallback

    func testRemoveActiveFallsBackToAnother() {
        let a = makeDevice(label: "alpha", room: "ra", lastActive: 100)
        let b = makeDevice(label: "beta", room: "rb", lastActive: 200)
        store.upsert(a); store.upsert(b)
        store.setActiveId(a.id)
        let newActive = store.remove(a.id)
        XCTAssertEqual(newActive, b.id)          // fell back to the remaining device
        XCTAssertEqual(store.activeId(), b.id)
    }

    func testRemoveLastClearsActive() {
        let d = makeDevice()
        store.upsert(d)
        store.setActiveId(d.id)
        let newActive = store.remove(d.id)
        XCTAssertNil(newActive)
        XCTAssertNil(store.activeId())
    }

    func testRemoveInactiveKeepsActive() {
        let a = makeDevice(label: "alpha", room: "ra", lastActive: 100)
        let b = makeDevice(label: "beta", room: "rb", lastActive: 200)
        store.upsert(a); store.upsert(b)
        store.setActiveId(a.id)
        store.remove(b.id)                       // remove the non-active one
        XCTAssertEqual(store.activeId(), a.id)   // active unchanged
    }

    func testSetActiveIgnoresUnknownId() {
        let d = makeDevice()
        store.upsert(d)
        store.setActiveId("does-not-exist")
        XCTAssertEqual(store.activeId(), d.id)   // unchanged
    }

    // MARK: legacy migration

    private func seedLegacy(relay: String = "wss://legacy.example.com/",
                            room: String = "legacy-room", bearer: String? = "legacy-bearer") {
        legacy[KeychainStore.relayURL] = Data(relay.utf8)
        legacy[KeychainStore.room] = Data(room.utf8)
        if let bearer { legacy[KeychainStore.bearer] = Data(bearer.utf8) }
    }

    func testMigrateLegacyWrapsStandaloneCreds() {
        seedLegacy()
        let migrated = store.migrateLegacyIfNeeded()
        XCTAssertNotNil(migrated)
        XCTAssertEqual(migrated?.room, "legacy-room")
        XCTAssertEqual(migrated?.bearer, "legacy-bearer")
        XCTAssertEqual(migrated?.relayUrl, "wss://legacy.example.com/")
        XCTAssertEqual(migrated?.label, "legacy")             // host-derived label
        XCTAssertEqual(store.activeId(), migrated?.id)        // becomes the sole active device
        XCTAssertEqual(store.load().count, 1)
    }

    func testMigrateIsIdempotent() {
        seedLegacy()
        let first = store.migrateLegacyIfNeeded()
        XCTAssertNotNil(first)
        let second = store.migrateLegacyIfNeeded()   // already has a device → no-op
        XCTAssertNil(second)
        XCTAssertEqual(store.load().count, 1)
    }

    func testMigrateNoOpWithoutLegacyCreds() {
        XCTAssertNil(store.migrateLegacyIfNeeded())
        XCTAssertTrue(store.load().isEmpty)
    }

    func testMigrateSkippedWhenDevicesExist() {
        // A device already exists → migration must not run even if legacy items are present.
        store.upsert(makeDevice())
        seedLegacy()
        XCTAssertNil(store.migrateLegacyIfNeeded())
        XCTAssertEqual(store.load().count, 1)
    }

    func testMigrateWithoutBearer() {
        seedLegacy(bearer: nil)
        let migrated = store.migrateLegacyIfNeeded()
        XCTAssertNotNil(migrated)
        XCTAssertNil(migrated?.bearer)
    }
}
