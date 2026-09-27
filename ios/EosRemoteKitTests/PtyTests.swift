import XCTest
@testable import EosRemoteKit

// Terminals (daemon PTY sessions): parsing the conversation's `pending` question/plan, the
// conversation paging/reset rules, the mirror's replay ordering, and the `sub` frame shape.
final class PtyTests: XCTestCase {
    private func json(_ any: Any) -> JSONValue {
        let data = try! JSONSerialization.data(withJSONObject: any)
        return try! JSONDecoder().decode(JSONValue.self, from: data)
    }

    // A GET /pty/:id/conversation row — payload arrives as an object, not a JSON string.
    private func row(_ id: Int, _ type: String, _ payload: [String: Any]) -> JSONValue {
        json(["id": id, "ts": 1000 + id, "type": type, "payload": payload])
    }

    private let askInput: [String: Any] = ["questions": [[
        "header": "Scope", "question": "Which files?", "multiSelect": false,
        "options": [["label": "All", "description": "Every file"], ["label": "Changed"]],
    ]]]

    // MARK: PendingPrompt

    func testPendingAskUserQuestionIsParsed() {
        let pending = json(["toolUseId": "q1", "name": "AskUserQuestion", "input": askInput])
        XCTAssertEqual(PendingPrompt(pending: pending), .questions(toolUseId: "q1", [
            PendingQuestion(header: "Scope", question: "Which files?", multiSelect: false, options: [
                .init(label: "All", description: "Every file"), .init(label: "Changed", description: nil),
            ]),
        ]))
    }

    func testPendingPlanIsParsed() {
        let pending = json(["toolUseId": "p1", "name": "ExitPlanMode", "input": ["plan": "## Plan\n1. Do it"]])
        XCTAssertEqual(PendingPrompt(pending: pending), .plan(toolUseId: "p1", markdown: "## Plan\n1. Do it"))
    }

    func testNoOrUnknownPendingIsNil() {
        XCTAssertNil(PendingPrompt(pending: nil))
        XCTAssertNil(PendingPrompt(pending: .null))
        XCTAssertNil(PendingPrompt(pending: json(["toolUseId": "x", "name": "Bash", "input": [:]])))
        XCTAssertNil(PendingPrompt(pending: json(["toolUseId": "q", "name": "AskUserQuestion",
                                                  "input": ["questions": []]])))
    }

    func testAnswerWireShape() {
        XCTAssertEqual(PendingAnswer.options([0, 2]).json,
                       .object(["options": .array([.number(0), .number(2)])]))
        XCTAssertEqual(PendingAnswer.text("both").json, .object(["text": .string("both")]))
    }

    // MARK: PtyTranscript

    private func page(_ session: String?, _ rows: [JSONValue], running: Bool = false,
                      pending: JSONValue = .null) -> JSONValue {
        .object(["claudeSessionId": session.map(JSONValue.string) ?? .null,
                 "rows": .array(rows), "running": .bool(running), "pending": pending])
    }

    func testInitialPageThenDeltaDedupesById() {
        var t = PtyTranscript()
        XCTAssertEqual(t.apply(page("s1", [row(1, "user_message", ["text": "a"]),
                                           row(2, "user_message", ["text": "b"])], running: true), afterId: 0), .changed)
        XCTAssertEqual(t.newestId, 2)
        XCTAssertTrue(t.running)
        XCTAssertEqual(t.apply(page("s1", [row(2, "user_message", ["text": "b"]),
                                           row(3, "user_message", ["text": "c"])], running: true), afterId: 2), .changed)
        XCTAssertEqual(t.evs.count, 3)
        XCTAssertEqual(t.newestId, 3)
    }

    func testEmptyPageIsUnchangedUnlessRunningFlips() {
        var t = PtyTranscript()
        _ = t.apply(page("s1", [row(1, "user_message", ["text": "a"])]), afterId: 0)
        XCTAssertEqual(t.apply(page("s1", []), afterId: 1), .unchanged)
        XCTAssertEqual(t.apply(page("s1", [], running: true), afterId: 1), .changed)
    }

    func testPendingOpeningAndClosingIsAChange() {
        var t = PtyTranscript()
        _ = t.apply(page("s1", [], running: true), afterId: 0)
        let ask = json(["toolUseId": "q1", "name": "AskUserQuestion", "input": askInput])
        XCTAssertEqual(t.apply(page("s1", [], running: true, pending: ask), afterId: 0), .changed)
        XCTAssertEqual(t.pending?.toolUseId, "q1")
        XCTAssertEqual(t.apply(page("s1", [], running: true, pending: ask), afterId: 0), .unchanged)
        XCTAssertEqual(t.apply(page("s1", [], running: true), afterId: 0), .changed)
        XCTAssertNil(t.pending)
    }

    func testNewClaudeSessionWhilePagingRefetchesFromZero() {
        var t = PtyTranscript()
        _ = t.apply(page("s1", [row(1, "user_message", ["text": "a"]), row(2, "user_message", ["text": "b"])]),
                    afterId: 0)
        XCTAssertEqual(t.apply(page("s2", [row(3, "user_message", ["text": "late"])]), afterId: 2), .refetch)
        XCTAssertEqual(t.claudeSessionId, "s2")
        XCTAssertTrue(t.evs.isEmpty)
        XCTAssertEqual(t.newestId, 0)
        XCTAssertEqual(t.apply(page("s2", [row(1, "user_message", ["text": "fresh"])]), afterId: 0), .changed)
        XCTAssertEqual(t.evs.count, 1)
    }

    func testTranscriptFeedsBuildBlocks() {
        var t = PtyTranscript()
        _ = t.apply(page("s1", [
            row(1, "user_message", ["text": "hi"]),
            row(2, "agent_event", ["type": "message", "role": "assistant",
                                   "blocks": [["type": "text", "text": "hello", "blockId": "b1"]]]),
        ]), afterId: 0)
        let blocks = MessageNormalizer.buildBlocks(evs: t.evs, workerId: "pty-1")
        XCTAssertEqual(blocks.map(\.payload), [.user(text: "hi", optimistic: false), .assistant(text: "hello")])
    }

    // MARK: PtyReplayGate

    func testFramesAreHeldUntilReplayThenDeduped() {
        var g = PtyReplayGate()
        XCTAssertEqual(g.frame(seq: 1, data: "a"), [])
        XCTAssertEqual(g.frame(seq: 2, data: "b"), [])
        XCTAssertEqual(g.replay(seq: 1, data: "A"), ["A", "b"])   // seq 1 is covered by the buffer
        XCTAssertEqual(g.frame(seq: 3, data: "c"), ["c"])
        XCTAssertEqual(g.frame(seq: 3, data: "again"), [])
    }

    func testMissingBufferWritesEveryHeldFrame() {
        var g = PtyReplayGate()
        _ = g.frame(seq: 5, data: "x")
        XCTAssertEqual(g.replay(seq: 0, data: ""), ["x"])
    }

    func testReplayIsIdempotent() {
        var g = PtyReplayGate()
        XCTAssertEqual(g.replay(seq: 2, data: "A"), ["A"])
        XCTAssertEqual(g.replay(seq: 9, data: "B"), [])
        XCTAssertEqual(g.frame(seq: 3, data: "c"), ["c"])
    }

    // MARK: wire + model

    func testSubFrameShape() throws {
        let data = try JSONEncoder().encode(SubFrame(pty: ["a", "b"]))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["t"] as? String, "sub")
        XCTAssertEqual(obj["pty"] as? [String], ["a", "b"])
    }

    func testPtySessionDisplayTitle() {
        XCTAssertEqual(PtySession(raw: json(["sessionId": "a", "number": 2, "kind": "claude"])).displayTitle,
                       "Claude Code")
        XCTAssertEqual(PtySession(raw: json(["sessionId": "b", "number": 3, "kind": "shell"])).displayTitle,
                       "Terminal 3")
        XCTAssertEqual(PtySession(raw: json(["sessionId": "c", "number": 4, "kind": "claude", "title": "fix auth"]))
                        .displayTitle, "fix auth")
    }
}
