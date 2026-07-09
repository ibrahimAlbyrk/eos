import XCTest
@testable import EosRemoteKit

// Perf benchmarks for the transcript hot path (Phase 6). These quantify the cost of the full-scan
// `buildBlocks` pipeline that DeviceConnection.recompute() runs on every incoming event, plus the
// incremental "append one event to a large transcript" case that a live burst produces.
//
// Rows are built exactly as GET /workers/:id/events returns them: payload is a serialized JSON STRING
// (the DB column), so the pipeline pays the real JSON decode cost, not a pre-parsed-object shortcut.
final class PerfBenchmarks: XCTestCase {

    // A durable row with a STRING payload, matching the daemon's wire shape.
    private func row(id: Int, ts: Double, type: String, payload: [String: Any]) -> JSONValue {
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return .object([
            "id": .number(Double(id)), "worker_id": .string("w1"), "ts": .number(ts),
            "type": .string(type), "payload": .string(String(decoding: data, as: UTF8.self)),
        ])
    }

    // A synthetic large transcript with a realistic mix of block kinds: assistant/thinking text,
    // main-lane tool_use + tool_result pairs, tool_running/tool_done lifecycle, user turns, and a
    // sprinkle of agent_event canonical messages. `count` rows, ascending ts.
    private func makeTranscript(_ count: Int) -> [JSONValue] {
        var rows: [JSONValue] = []
        rows.reserveCapacity(count)
        var id = 1
        var ts = 1000.0
        func push(_ type: String, _ payload: [String: Any]) {
            rows.append(row(id: id, ts: ts, type: type, payload: payload)); id += 1; ts += 1
        }
        // Repeat a ~10-row conversational cycle until we reach `count`.
        while rows.count < count {
            let n = rows.count
            push("user_message", ["text": "Please do task number \(n) with care and attention."])
            push("jsonl", ["kind": "thinking", "text": "Considering the approach for task \(n). ".replicated(6),
                           "blockId": "th-\(n)"])
            push("jsonl", ["kind": "assistant_text", "text": "Here is my plan for step \(n): ".replicated(8),
                           "blockId": "as-\(n)"])
            let t1 = "tool-\(n)-a"
            push("jsonl", ["kind": "tool_use", "id": t1, "name": "Read", "input": ["file_path": "/src/file\(n).swift"]])
            push("jsonl", ["kind": "tool_result", "toolUseId": t1, "text": "file contents ".replicated(20), "isError": false])
            let t2 = "tool-\(n)-b"
            push("jsonl", ["kind": "tool_use", "id": t2, "name": "Bash", "input": ["command": "echo build \(n)"]])
            push("tool_running", ["toolName": "Bash", "toolUseId": t2, "input": ["command": "echo build \(n)"]])
            push("tool_done", ["toolName": "Bash", "toolUseId": t2, "result": "build ok ".replicated(4)])
            push("agent_event", [
                "type": "message", "role": "assistant",
                "blocks": [
                    ["type": "reasoning", "text": "canonical reasoning for \(n)", "blockId": "cr-\(n)"],
                    ["type": "text", "text": "canonical answer \(n)", "blockId": "ca-\(n)"],
                    ["type": "tool_call", "name": "Grep", "callId": "call-\(n)", "input": ["pattern": "foo\(n)"]],
                ],
            ])
            push("agent_event", ["type": "turn", "phase": "completed"])
        }
        return Array(rows.prefix(count))
    }

    // ---- Full-scan buildBlocks: the exact call recompute() makes every event ----

    func testBuildBlocks500() {
        let rows = makeTranscript(500)
        // Warm any static caches, and assert the pipeline actually produced blocks (guards against
        // measuring a no-op).
        XCTAssertGreaterThan(MessageNormalizer.buildBlocks(rows, workerId: "w1").count, 100)
        measure { _ = MessageNormalizer.buildBlocks(rows, workerId: "w1") }
    }

    func testBuildBlocks2000() {
        let rows = makeTranscript(2000)
        XCTAssertGreaterThan(MessageNormalizer.buildBlocks(rows, workerId: "w1").count, 400)
        measure { _ = MessageNormalizer.buildBlocks(rows, workerId: "w1") }
    }

    // ---- Incremental case: one event appended to a large existing transcript ----
    // Mirrors a live agent:delta / newest-row ingest: durable set already large, one new row arrives,
    // recompute() re-runs the FULL scan. This is the per-frame cost during a streaming burst.

    func testBuildBlocksIncremental2000() {
        var rows = makeTranscript(2000)
        _ = MessageNormalizer.buildBlocks(rows, workerId: "w1")   // warm
        rows.append(row(id: 99999, ts: 99999, type: "jsonl",
                        payload: ["kind": "assistant_text", "text": "one more streamed line", "blockId": "as-tail"]))
        measure { _ = MessageNormalizer.buildBlocks(rows, workerId: "w1") }
    }

    // ---- The ACTUAL recompute optimization: parse-once cache (mirrors DeviceConnection) ----
    // BEFORE: every event re-decoded every durable row's JSON-string payload (testBuildBlocksIncremental
    // above). AFTER: rows are decoded ONCE at ingest and cached as `Ev`; a new event only decodes the
    // one new row and rebuilds from the cached Evs via buildBlocks(evs:). This benchmark measures that
    // marginal per-event cost — the real per-frame work the live path now does.
    func testRecomputeIncrementalWithParseCache2000() {
        let rows = makeTranscript(2000)
        // Simulate ingest: parse every row ONCE into the Ev cache (this cost is paid at ingest, not
        // per frame). Keyed by rowId, exactly as DeviceConnection.durableEvs.
        var cache: [String: Ev] = [:]
        for r in rows { cache[String(r["id"]!.intValue!)] = toEv(r) }
        _ = MessageNormalizer.buildBlocks(evs: Array(cache.values), workerId: "w1")   // warm
        let newRow = row(id: 99999, ts: 99999, type: "jsonl",
                         payload: ["kind": "assistant_text", "text": "one more streamed line", "blockId": "as-tail"])
        // Per-frame work AFTER the fix: decode the single new row + rebuild from cached Evs.
        measure {
            cache["99999"] = toEv(newRow)
            _ = MessageNormalizer.buildBlocks(evs: Array(cache.values), workerId: "w1")
        }
    }

    // The overlay-only frame (a streaming agent:delta with NO new durable row) is the most common live
    // event. AFTER the fix the durable buildBlocks is memoized and reused, so this frame does ZERO
    // reparse — only a cheap overlay merge + sort. Measured here as "reuse cached durable blocks, append
    // one live overlay, sort" — the exact work recompute() does on an overlay-only frame.
    func testRecomputeOverlayOnly2000() {
        let rows = makeTranscript(2000)
        let durable = MessageNormalizer.buildBlocks(rows, workerId: "w1")   // computed once, memoized
        measure {
            var all = durable
            all.append(Block(id: "live:as-tail", workerId: "w1", blockId: "as-tail", ts: 99999, live: true,
                             payload: .assistant(text: "streaming token")))
            _ = sortBlocksByTs(all)
        }
    }
}

private extension String {
    // Cheap way to make a payload string non-trivial (exercises real JSON decode of longer strings).
    func replicated(_ n: Int) -> String { String(repeating: self, count: n) }
}
