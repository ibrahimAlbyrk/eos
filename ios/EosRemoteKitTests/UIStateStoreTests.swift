import XCTest
@testable import EosRemoteKit

// UIStateStore (round 7): the per-device persisted UI state behind launch restoration, plus the
// stale-id fallback decision. Isolated UserDefaults suite per test (DeviceStoreTests pattern).
final class UIStateStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private var store: UIStateStore!

    override func setUp() {
        super.setUp()
        suiteName = "UIStateStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        store = UIStateStore(defaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: persistence

    func testEmptyByDefault() {
        XCTAssertEqual(store.state(for: "mac-a"), RestorableUIState())
    }

    // A fresh instance over the same defaults = a new app launch.
    func testRoundTripAcrossInstances() {
        store.update(for: "mac-a") {
            $0.filter = "Running"; $0.openWorkerId = "w1"; $0.section = "devices"
        }
        let reloaded = UIStateStore(defaults: defaults).state(for: "mac-a")
        XCTAssertEqual(reloaded, RestorableUIState(filter: "Running", openWorkerId: "w1",
                                                   section: "devices"))
    }

    func testPartialUpdateKeepsOtherFields() {
        store.update(for: "mac-a") { $0.filter = "Archived" }
        store.update(for: "mac-a") { $0.openWorkerId = "w9" }
        let s = store.state(for: "mac-a")
        XCTAssertEqual(s.filter, "Archived")
        XCTAssertEqual(s.openWorkerId, "w9")
    }

    func testScopedPerDevice() {
        store.update(for: "mac-a") { $0.openWorkerId = "wA"; $0.filter = "Running" }
        store.update(for: "mac-b") { $0.openWorkerId = "wB" }
        XCTAssertEqual(store.state(for: "mac-a").openWorkerId, "wA")
        XCTAssertEqual(store.state(for: "mac-b").openWorkerId, "wB")
        XCTAssertNil(store.state(for: "mac-b").filter)   // Mac A's filter never leaks to B
    }

    func testNilDeviceReadsEmptyAndWritesNowhere() {
        store.update(for: nil) { $0.openWorkerId = "w1" }
        XCTAssertEqual(store.state(for: nil), RestorableUIState())
        XCTAssertEqual(store.state(for: "mac-a"), RestorableUIState())
    }

    func testCorruptIndexReadsEmpty() {
        defaults.set(Data("not json".utf8), forKey: "dev.eos.remote.uistate.index")
        XCTAssertEqual(store.state(for: "mac-a"), RestorableUIState())
    }

    // MARK: stale-id fallback decision

    func testKeepsOpenUntilConnectedAndLoaded() {
        XCTAssertFalse(UIRestore.shouldClose(openId: "w1", connected: false, workersLoaded: false,
                                             workerIds: [], archivedIds: []))
        XCTAssertFalse(UIRestore.shouldClose(openId: "w1", connected: true, workersLoaded: false,
                                             workerIds: [], archivedIds: []))
        XCTAssertFalse(UIRestore.shouldClose(openId: "w1", connected: false, workersLoaded: true,
                                             workerIds: [], archivedIds: []))
    }

    func testKeepsOpenWhenLiveOrArchived() {
        XCTAssertFalse(UIRestore.shouldClose(openId: "w1", connected: true, workersLoaded: true,
                                             workerIds: ["w1", "w2"], archivedIds: []))
        XCTAssertFalse(UIRestore.shouldClose(openId: "w1", connected: true, workersLoaded: true,
                                             workerIds: ["w2"], archivedIds: ["w1"]))
    }

    func testClosesWhenGoneFromBothLists() {
        XCTAssertTrue(UIRestore.shouldClose(openId: "w1", connected: true, workersLoaded: true,
                                            workerIds: ["w2"], archivedIds: ["w3"]))
        XCTAssertTrue(UIRestore.shouldClose(openId: "w1", connected: true, workersLoaded: true,
                                            workerIds: [], archivedIds: []))
    }
}
