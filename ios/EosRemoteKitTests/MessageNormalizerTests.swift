import XCTest
@testable import EosRemoteKit

// MessageNormalizer against real GET /workers/:id/events row shapes: payload is a JSON STRING,
// claude-sdk rows are `agent_event` canonical messages with an ordered blocks[]. Guards the
// transcript-render path the device depends on (the Simulator can't drive the live UI).
final class MessageNormalizerTests: XCTestCase {
    // Build a row exactly as the daemon returns it: payload is a serialized JSON string.
    private func row(id: Int, ts: Double, type: String, payload: Any?) -> JSONValue {
        var obj: [String: JSONValue] = [
            "id": .number(Double(id)), "worker_id": .string("w1"), "ts": .number(ts), "type": .string(type),
        ]
        if let payload {
            let data = try! JSONSerialization.data(withJSONObject: payload)
            obj["payload"] = .string(String(decoding: data, as: UTF8.self))
        }
        return .object(obj)
    }

    func testUserMessage() {
        let blocks = MessageNormalizer.normalize(
            [row(id: 1, ts: 100, type: "user_message", payload: ["text": "hello there"])], workerId: "w1")
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks[0].kind, .user)
        XCTAssertEqual(blocks[0].text, "hello there")
    }

    func testAgentEventMessageExpandsBlocksInOrder() {
        let payload: [String: Any] = [
            "type": "message", "role": "assistant",
            "blocks": [
                ["type": "reasoning", "text": "let me think", "blockId": "b-r"],
                ["type": "text", "text": "the answer is 42", "blockId": "b-t"],
                ["type": "tool_call", "name": "Bash", "callId": "c1"],
            ],
        ]
        let blocks = MessageNormalizer.normalize([row(id: 7, ts: 200, type: "agent_event", payload: payload)], workerId: "w1")
        XCTAssertEqual(blocks.map(\.kind), [.thinking, .assistant, .tool])     // array order preserved
        XCTAssertEqual(blocks[1].text, "the answer is 42")
        XCTAssertEqual(blocks[0].blockId, "b-r")                                // carried for live-overlay drop
        XCTAssertEqual(blocks[1].blockId, "b-t")
    }

    func testNoiseRowsFiltered() {
        let rows = [
            row(id: 1, ts: 1, type: "heartbeat", payload: ["elapsedMs": 10]),
            row(id: 2, ts: 2, type: "usage", payload: ["out": 5]),
            row(id: 3, ts: 3, type: "state", payload: ["state": "BUSY"]),
            row(id: 4, ts: 4, type: "lifecycle", payload: ["phase": "prompt_sent"]),
        ]
        XCTAssertTrue(MessageNormalizer.normalize(rows, workerId: "w1").isEmpty)
    }

    func testEmptyTextDropped() {
        let payload: [String: Any] = ["type": "message", "role": "assistant",
                                      "blocks": [["type": "text", "text": "   "]]]
        XCTAssertTrue(MessageNormalizer.normalize([row(id: 9, ts: 1, type: "agent_event", payload: payload)], workerId: "w1").isEmpty)
    }

    func testLegacyJsonl() {
        let rows = [
            row(id: 1, ts: 1, type: "jsonl", payload: ["kind": "assistant_text", "text": "hi"]),
            row(id: 2, ts: 2, type: "jsonl", payload: ["kind": "thinking", "text": "hmm"]),
            row(id: 3, ts: 3, type: "jsonl", payload: ["kind": "tool_use", "name": "Read"]),
        ]
        XCTAssertEqual(MessageNormalizer.normalize(rows, workerId: "w1").map(\.kind), [.assistant, .thinking, .tool])
    }
}
