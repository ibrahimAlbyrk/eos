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
        // A button outside a repeat, as the phone renderer writes it (morning-paper phone golden).
        XCTAssertEqual(EosAction.parse(URL(string: "eos-action:si-000000000041/good/")!),
                       EosAction(issueId: "si-000000000041", button: "good", index: nil))
        XCTAssertNil(EosAction.parse(URL(string: "eos-action:si-1/approve/x")!))
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
        XCTAssertEqual(EosAction(issueId: "si-1", button: "good", index: nil).request(clientId: "c-1"),
                       .object(["issueId": .string("si-1"), "button": .string("good"), "clientId": .string("c-1")]),
                       "no index outside a repeat")
        XCTAssertEqual(EosActionAnswer(.object(["status": .string("done"), "recordId": .string("r")])), .done)
        XCTAssertEqual(EosActionAnswer(.object(["status": .string("confirm"), "recordId": .string("r"),
                                                "token": .string("t"), "prompt": .string("Send it?")])),
                       .confirm(token: "t", prompt: "Send it?", typeToConfirm: nil))
        XCTAssertEqual(EosActionAnswer(.object(["status": .string("held"), "recordId": .string("r"),
                                                "itemId": .string("in-1")])), .held(itemId: "in-1"))
        XCTAssertEqual(EosActionAnswer(.object(["error": .string("forbidden")])), .refused("forbidden"))
    }
}

final class OutboxTests: XCTestCase {
    private func outbox() -> (AnswerOutbox, URL) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
        return (AnswerOutbox(file: file), file)
    }

    func testAnswersWaitForTheMacAndGoInOrderOnceItIsBack() async {
        let (box, file) = outbox()
        defer { try? FileManager.default.removeItem(at: file) }
        box.add(.answer(item: "in-1", rev: 3, kind: "run_start", choice: "run"))
        box.add(.discard(item: "in-2", rev: 1))
        let away = await box.flush { _, _, _ in nil }
        XCTAssertTrue(away.isEmpty, "the Mac is away: nothing leaves")
        XCTAssertEqual(AnswerOutbox(file: file).entries.count, 2, "kept across launches")

        var asked: [String] = []
        let done = await box.flush { _, path, _ in asked.append(path); return (200, .object([:])) }
        XCTAssertEqual(asked, ["/api/inbox/in-1/answer", "/api/inbox/in-2/discard"])
        XCTAssertEqual(done.map(\.1), [.sent, .sent])
        XCTAssertTrue(box.entries.isEmpty)
    }

    func testEachAnswerNamesItsRevisionAndAMovedOnItemAnswersChanged() async {
        let (box, file) = outbox()
        defer { try? FileManager.default.removeItem(at: file) }
        let send = OutboxEntry.send(item: "in-1", rev: 4, doc: nil, confirmStale: false)
        XCTAssertEqual(send.body, .object(["rev": .number(4)]))
        box.add(send)
        let done = await box.flush { _, _, _ in (409, .object(["error": .string("changed"), "rev": .number(5)])) }
        XCTAssertEqual(done.map(\.1), [.changed("It changed on your Mac.")], "never sent again on the new state")
        XCTAssertTrue(box.entries.isEmpty)
        XCTAssertEqual(AnswerOutbox.result(status: 409, body: .object(["error": .string("stale"),
                                                                  "staleReason": .string("new commits")])),
                       .stale("new commits"))
    }

    func testANewerAnswerToAnItemTakesThePlaceOfOneNotSent() {
        let (box, file) = outbox()
        defer { try? FileManager.default.removeItem(at: file) }
        box.add(.later(item: "in-1"))
        box.add(.discard(item: "in-1", rev: 2))
        box.add(.start(.object(["routineId": .string("rt-1")])))
        XCTAssertEqual(box.entries.map(\.path), ["/api/inbox/in-1/discard", "/api/runs"])
    }

    func testADraftReadsTheUsersSavedEditsFirstAndAPageIsEditedOnItsPage() throws {
        let doc: JSONValue = .object(["kind": .string("github.review"), "channel": .string("github"),
                                      "action": .string("review"),
                                      "parts": .array([.object(["key": .string("summary"), "role": .string("summary"),
                                                                "text": .string("held")])])])
        var working = doc
        if case .object(var o) = working {
            o["parts"] = .array([.object(["key": .string("summary"), "role": .string("summary"),
                                          "text": .string("edited")])])
            working = .object(o)
        }
        XCTAssertEqual(ResultDocument.of(detail: .object(["payload": .object(["doc": doc])]))?.parts.first?.text, "held")
        XCTAssertEqual(ResultDocument.of(detail: .object(["payload": .object(["doc": doc]), "working": working]))?
            .parts.first?.text, "edited")
        let page = ResultDocument(kind: "page.issue", channel: "c", action: "a", parts: [])
        XCTAssertFalse(page.editable)
        XCTAssertTrue(ResultDocument.removable(ResultPart(key: "c:1", role: "comment", text: "x", meta: nil)))
        let edited = try JSONValue(encodable: page)
        XCTAssertEqual(OutboxEntry.send(item: "i", rev: 1, doc: page, confirmStale: true).body,
                       .object(["rev": .number(1), "doc": edited, "confirmStale": .bool(true)]))
    }
}

final class EosLinkTests: XCTestCase {
    func testEachRoutineLinkOpensItsPlaceAndNoneStartsARun() {
        XCTAssertEqual(EosLink.parse(URL(string: "eos://run/pr-review?item=%23470&note=quick&show-only=1")!),
                       .runForm(routine: "pr-review", item: "#470", note: "quick", showOnly: true))
        XCTAssertEqual(EosLink.parse(URL(string: "eos://run/pr-review")!),
                       .runForm(routine: "pr-review", item: nil, note: nil, showOnly: false))
        XCTAssertNil(EosLink.parse(URL(string: "eos://run")!))
        XCTAssertEqual(EosLink.parse(URL(string: "eos://runs/rn-82fa1c0d3e9b")!), .run("rn-82fa1c0d3e9b"))
        XCTAssertEqual(EosLink.parse(URL(string: "eos://inbox/in-7")!), .inbox(item: "in-7", device: nil))
        XCTAssertEqual(EosLink.parse(URL(string: "eos://inbox?device=dev-b")!), .inbox(item: nil, device: "dev-b"))
        XCTAssertNil(EosLink.parse(URL(string: "eos://worker/w1")!), "the app's own links stay its own")
        XCTAssertNil(EosLink.parse(URL(string: "https://run/x")!))
    }
}
