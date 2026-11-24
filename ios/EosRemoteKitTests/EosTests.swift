import XCTest
@testable import EosRemoteKit

final class EosTests: XCTestCase {
    // A row of GET /api/routines as the Mac writes it (eos-contracts `RoutineSummary`), with a field
    // this app does not know.
    private let routineJSON = #"""
    {"id":"rt-1","slug":"pr-review","name":"PR Review","summary":"Reviews pull requests.","icon":"eye",
     "aliases":[],"kind":"standing","state":"active","rung":"draft","triggerLine":"When a pull request opens",
     "takes":{"kind":"github.pull_request","source":"github.pulls","label":"pull request",
              "placeholder":"#470 or a link","empty":"latest","many":true,"itemPatterns":[]},
     "options":[{"key":"depth","label":"Depth","type":"choice","values":["quick","deep"],"default":"quick",
                 "inline":true}],
     "runs7d":3,"activeRuns":1,"later":{"x":1},
     "lastRun":{"id":"rn-9","routineId":"rt-1","kind":"standing","origin":"trigger","state":"waiting_for_user",
                "needsUser":true,"costUsd":0.42,"workMs":61000,"createdAt":1700000000000}}
    """#

    func testARoutineRowReadsAsTheMacWritesIt() throws {
        let routine = try JSONDecoder().decode(EosRoutine.self, from: Data(routineJSON.utf8))
        XCTAssertEqual(routine.name, "PR Review")
        XCTAssertEqual(routine.triggerLine, "When a pull request opens")
        XCTAssertEqual(routine.options.first?.default, .string("quick"))
        XCTAssertEqual(routine.lastRun?.state, "waiting_for_user")
        XCTAssertEqual(routine.lastRun?.ended, false)
    }

    func testTypedTextIsALinkWhenItIsOneAndTheUsersOwnOtherwise() {
        XCTAssertEqual(EosItem.typed(" https://github.com/acme/game/pull/470 "),
                       EosItem(kind: "link", url: "https://github.com/acme/game/pull/470", untrusted: true))
        XCTAssertEqual(EosItem.typed("#470"), EosItem(kind: "text", text: "#470", untrusted: false))
        XCTAssertNil(EosItem.typed("  "))
        XCTAssertEqual(EosItem.typed("ftp://x/y")?.kind, "text")
    }

    func testAStartNamesThePhoneAsItsDoorAndLeavesOutWhatWasNotSet() {
        let body = EosRequests.startRun(routineId: "rt-1", item: EosItem(kind: "text", text: "#470", untrusted: false),
                                        options: ["depth": .string("deep")], note: "  ", showOnly: true,
                                        requestId: "req-1")
        XCTAssertEqual(body["door"], .string("phone"))
        XCTAssertEqual(body["clientRequestId"], .string("req-1"))
        XCTAssertEqual(body["input"]?["result"], .string("showOnly"))
        XCTAssertEqual(body["input"]?["options"]?["depth"], .string("deep"))
        XCTAssertNil(body["input"]?["note"], "an empty note is no note")
        XCTAssertEqual(body["input"]?["item"]?["untrusted"], .bool(false))
        XCTAssertNil(EosRequests.startRun(routineId: "rt-1", item: nil, options: [:], note: nil, showOnly: false,
                                          requestId: "r")["input"]?["item"])
    }

    func testEachEosTopicReadsAgainWhatItChanged() {
        XCTAssertEqual(EosRefresh.of(topic: "inbox:change", payload: nil), [.inbox])
        XCTAssertEqual(EosRefresh.of(topic: "run:change", payload: .object(["runId": .string("rn-1")])),
                       [.routines, .run("rn-1")])
        XCTAssertEqual(EosRefresh.of(topic: "routine:change", payload: nil), [.routines])
        XCTAssertEqual(EosRefresh.of(topic: "worker:change", payload: nil), [.none])
    }

    func testTheCacheKeepsEachMacsListsApart() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("eos-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = EosCache(dir: dir)
        XCTAssertNil(cache.load(device: "a"))
        let routine = try JSONDecoder().decode(EosRoutine.self, from: Data(routineJSON.utf8))
        cache.save(EosSnapshot(routines: [routine], inbox: [], seenAt: 12), device: "a")
        XCTAssertEqual(cache.load(device: "a"), EosSnapshot(routines: [routine], inbox: [], seenAt: 12))
        XCTAssertNil(cache.load(device: "b"))
        cache.remove(device: "a")
        XCTAssertNil(cache.load(device: "a"))
    }
}

final class EosActionTests: XCTestCase {
    func testOnlyAWellFormedEosActionLinkIsAButton() {
        XCTAssertEqual(EosAction.parse(URL(string: "eos-action:si-1/approve/0")!),
                       EosAction(issueId: "si-1", button: "approve", index: 0))
        XCTAssertNil(EosAction.parse(URL(string: "https://evil.example/si-1/approve/0")!))
        XCTAssertNil(EosAction.parse(URL(string: "eos-action:si-1/approve")!))
        XCTAssertNil(EosAction.parse(URL(string: "eos-action:si-1/approve/-1")!))
        XCTAssertNil(EosAction.parse(URL(string: "eos-action://si-1/approve/0")!), "no host form")
    }

    func testThePressGoesAsTheMacsRouteReadsItAndItsAnswersAreKnown() {
        let press = EosAction(issueId: "si-1", button: "approve", index: 2)
        XCTAssertEqual(press.request(clientId: "c-1"),
                       .object(["issueId": .string("si-1"), "button": .string("approve"), "index": .number(2),
                                "clientId": .string("c-1")]))
        XCTAssertEqual(press.request(clientId: "c-1", confirm: "tok", typed: "Prod")["confirm"], .string("tok"))
        XCTAssertEqual(EosActionAnswer(.object(["status": .string("done"), "recordId": .string("r")])), .done)
        XCTAssertEqual(EosActionAnswer(.object(["status": .string("confirm"), "recordId": .string("r"),
                                                "token": .string("t"), "prompt": .string("Send it?")])),
                       .confirm(token: "t", prompt: "Send it?", typeToConfirm: nil))
        XCTAssertEqual(EosActionAnswer(.object(["status": .string("held"), "recordId": .string("r"),
                                                "itemId": .string("in-1")])), .held(itemId: "in-1"))
        XCTAssertEqual(EosActionAnswer(.object(["error": .string("forbidden")])), .refused("forbidden"))
    }
}
