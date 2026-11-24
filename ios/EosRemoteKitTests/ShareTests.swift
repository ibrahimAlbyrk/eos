import XCTest
@testable import EosRemoteKit

// The share extension's pieces that need no extension host: what was shared, which routines take
// it, the start it sends, the outbox it waits in, and the devices it reads from the shared stores.
final class ShareTests: XCTestCase {
    private func routine(_ id: String, kind: String, patterns: [String]? = nil) throws -> EosRoutine {
        var takes: [String: Any] = ["kind": kind, "label": "item", "placeholder": "", "many": false]
        if let patterns { takes["itemPatterns"] = patterns }
        let row: [String: Any] = ["id": id, "slug": id, "name": id, "summary": "", "icon": "eye", "kind": "standing",
                                  "state": "active", "takes": takes, "options": [], "activeRuns": 0]
        return try JSONDecoder().decode(EosRoutine.self, from: JSONSerialization.data(withJSONObject: row))
    }

    func testASharedLinkOrTextIsOutsideText() {
        let link = SharedThing.of(url: URL(string: "https://github.com/acme/game/pull/470"), text: "ignored",
                                  title: " Fix the map ")
        XCTAssertEqual(link?.item, EosItem(kind: "link", title: "Fix the map",
                                           url: "https://github.com/acme/game/pull/470", untrusted: true))
        let text = SharedThing.of(url: nil, text: "look at #470", title: nil)
        XCTAssertEqual(text?.item, EosItem(kind: "text", text: "look at #470", untrusted: true))
        XCTAssertEqual(SharedThing.of(url: nil, text: "https://example.com/a", title: nil)?.item.kind, "link")
        XCTAssertNil(SharedThing.of(url: URL(string: "file:///etc/hosts"), text: nil, title: nil),
                     "a file link is no web page")
        XCTAssertNil(SharedThing.of(url: nil, text: "   ", title: nil))
        let long = SharedThing.of(url: nil, text: String(repeating: "a", count: 5_000), title: nil)
        XCTAssertEqual(long?.value.count, SharedThing.matchMax)
    }

    func testTheMatchReadAsksAboutTheThingAndNamesTheRoutinesInItsOrder() throws {
        let thing = try XCTUnwrap(SharedThing.of(url: nil, text: "#470", title: nil))
        XCTAssertEqual(thing.matchRequest, .object(["item": .object(["kind": .string("text"), "value": .string("#470")])]))
        let listed = [try routine("rt-a", kind: "text"), try routine("rt-b", kind: "github.pull_request")]
        let answer: JSONValue = .object(["choices": .array([
            .object(["intent": .string("run"), "line": .string("Run b"), "routineId": .string("rt-b")]),
            .object(["intent": .string("run"), "line": .string("Run gone"), "routineId": .string("rt-gone")]),
            .object(["intent": .string("once"), "line": .string("Do it once, here")]),
        ])])
        XCTAssertEqual(SharedThing.matched(answer, among: listed)?.map(\.id), ["rt-b"])
        XCTAssertNil(SharedThing.matched(.object([:]), among: listed), "no choices: the Mac did not answer")
    }

    func testWithTheMacAwayTheLastListIsMatchedByKindOrPattern() throws {
        let thing = try XCTUnwrap(SharedThing.of(url: URL(string: "https://github.com/acme/game/pull/470"), text: nil,
                                                 title: nil))
        let listed = [
            try routine("by-kind", kind: "link"),
            try routine("by-pattern", kind: "github.pull_request", patterns: ["github\\.com/[^/]+/[^/]+/pull/\\d+"]),
            try routine("other", kind: "text", patterns: ["^#\\d+$"]),
            try routine("bad-pattern", kind: "text", patterns: ["("]),
            try routine("old-cache", kind: "github.pull_request"),
        ]
        XCTAssertEqual(thing.offlineMatches(listed).map(\.id), ["by-kind", "by-pattern"])
    }

    func testAStartFromTheShareSheetNamesItsDoorAndWaitsInTheOutboxBesideAnswers() throws {
        let thing = try XCTUnwrap(SharedThing.of(url: nil, text: "#470", title: nil))
        let body = thing.start(try routine("rt-a", kind: "text"), note: "quick look", requestId: "req-1")
        XCTAssertEqual(body["door"], .string("phone_share"))
        XCTAssertEqual(body["input"]?["item"]?["untrusted"], .bool(true))
        XCTAssertEqual(body["input"]?["note"], .string("quick look"))
        XCTAssertEqual(body["input"]?["result"], .string("usual"))

        let file = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        // The app and the extension each hold their own outbox over the same file.
        let app = AnswerOutbox(file: file), share = AnswerOutbox(file: file)
        app.add(.answer(item: "in-1", rev: 2, kind: "run_start", choice: "run"))
        share.add(.start(body))
        share.add(.start(body))
        XCTAssertEqual(app.entries.map(\.path), ["/api/inbox/in-1/answer", "/api/runs", "/api/runs"])
    }

    func testTheDeviceListMovesToTheSharedStoresOnce() {
        let old = UserDefaults(suiteName: "ShareTests.old.\(UUID().uuidString)")!
        let sharedName = "ShareTests.shared.\(UUID().uuidString)"
        let shared = UserDefaults(suiteName: sharedName)!
        defer { shared.removePersistentDomain(forName: sharedName) }
        let secrets = RecordingSecrets()
        let device = Device(id: "d-1", label: "mac", relayUrl: "wss://r/", room: "room", bearer: "bearer")
        DeviceStore(defaults: old, secrets: secrets, legacyGet: { _ in nil }).upsert(device)
        secrets.writes = 0

        let store = DeviceStore(defaults: shared, secrets: secrets, legacyGet: { _ in nil })
        XCTAssertTrue(store.load().isEmpty)
        store.shareWithExtension(from: old)
        XCTAssertEqual(store.load(), [device])
        XCTAssertEqual(store.activeId(), "d-1")
        XCTAssertEqual(secrets.writes, 1, "the secret is written again, into the shared Keychain group")
        store.shareWithExtension(from: old)
        XCTAssertEqual(secrets.writes, 1, "only once")
    }
}

private final class RecordingSecrets: SecretStore, @unchecked Sendable {
    private let inner = InMemorySecretStore()
    var writes = 0
    func set(_ key: String, _ value: Data) { writes += 1; inner.set(key, value) }
    func get(_ key: String) -> Data? { inner.get(key) }
    func delete(_ key: String) { inner.delete(key) }
}
