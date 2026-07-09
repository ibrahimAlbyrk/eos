import XCTest
@testable import EosRemoteKit

// Coverage for the Tier-2 tool-detail parsers (spec 03 §2.3/§2.5/§2.6/§3) the Phase-4c-ii detail views
// consume: the worker/peer result-JSON readers, the plain-text task parsers, the ToolSearch/delay
// helpers, and the workflow pretty/completion transforms. These mirror the JS fixtures in
// WorkerToolCard.test.js / toolViews.test.js.
final class ToolDetailParsingTests: XCTestCase {

    private func tool(_ name: String, input: [String: JSONValue] = [:], result text: String? = nil, error: Bool = false) -> Tool {
        Tool(id: "x", name: name, verb: verbFor(name), input: .object(input),
             result: text.map { ToolResult(text: $0, isError: error) }, running: false, done: true, ts: 0)
    }

    // MARK: - workerIdentity / worker bodies (§2.3)

    func testWorkerIdentityPrefersInputId() {
        let t = tool("mcp__orchestrator__kill_worker", input: ["id": .string("w-1")],
                     result: "{\"id\":\"w-1\",\"name\":\"probe\",\"state\":\"KILLING\"}")
        XCTAssertEqual(workerIdentity(t).id, "w-1")
        XCTAssertEqual(workerIdentity(t).name, "probe")
    }

    func testWorkerIdentityFallsBackToNestedWorker() {
        let t = tool("mcp__orchestrator__get_worker",
                     result: "{\"worker\":{\"id\":\"w-2\",\"name\":\"audit\"},\"events\":[1,2,3]}")
        XCTAssertEqual(workerIdentity(t).id, "w-2")
        XCTAssertEqual(workerIdentity(t).name, "audit")
    }

    func testKillWorkerDetail() {
        let t = tool("mcp__orchestrator__kill_worker", result: "{\"state\":\"KILLING\",\"branch\":\"eos-x\"}")
        XCTAssertEqual(killWorkerDetail(t), "KILLING · eos-x")
    }

    func testGetWorkerDetailJoinsCostAndEvents() {
        let t = tool("mcp__orchestrator__get_worker",
                     result: "{\"worker\":{\"state\":\"IDLE\",\"branch\":\"eos-y\",\"cost_usd\":0.1234,\"prompt\":\"do the thing\"},\"events\":[1,2]}")
        let body = getWorkerDetail(t)
        XCTAssertTrue(body.contains("IDLE · eos-y"))
        XCTAssertTrue(body.contains("$0.1234 · 2 events"))
        XCTAssertTrue(body.contains("do the thing"))
    }

    func testListWorkersRows() {
        let t = tool("mcp__orchestrator__list_active_workers",
                     result: "[{\"id\":\"w-a\",\"name\":\"one\",\"state\":\"IDLE\",\"prompt\":\"p1\"}]")
        let rows = listWorkersRows(t)
        XCTAssertEqual(rows?.count, 1)
        XCTAssertEqual(rows?.first?.name, "one")
        XCTAssertEqual(rows?.first?.meta, "IDLE")
        XCTAssertEqual(rows?.first?.sub, "p1")
    }

    func testWorkerListCountNilWhileRunning() {
        XCTAssertNil(workerListCount(tool("mcp__orchestrator__list_active_workers")))
    }

    func testSpawnLoopDetailsBounded() {
        let loop: JSONValue = .object([
            "goal": .object(["summary": .string("ship it")]), "strategy": .string("command"), "limit": .number(3),
        ])
        XCTAssertEqual(spawnLoopDetails(loop), "Loop: ship it · command · limit 3")
    }

    func testSpawnLoopDetailsUnbounded() {
        let loop: JSONValue = .object(["goal": .object(["summary": .string("ship it")])])
        XCTAssertEqual(spawnLoopDetails(loop), "Loop: ship it · hybrid · unbounded")
    }

    func testWorkerToolDetailTextErrorPassesThrough() {
        let t = tool("mcp__orchestrator__spawn_worker", input: ["prompt": .string("ignored")],
                     result: "denied by policy", error: true)
        XCTAssertEqual(workerToolDetailText(t), "denied by policy")
    }

    // MARK: - task plain-text parsers (§2.5)

    func testParseTaskGet() {
        let text = "Task #2: probe-B\nStatus: in_progress\nDescription: run the probe\nBlocks: #3\nBlocked by: #1"
        let task = parseTaskGet(text)
        XCTAssertEqual(task?.id, "2")
        XCTAssertEqual(task?.subject, "probe-B")
        XCTAssertEqual(task?.status, "in_progress")
        XCTAssertEqual(task?.description, "run the probe")
        XCTAssertEqual(task?.blocks, "#3")
        XCTAssertEqual(task?.blockedBy, "#1")
    }

    func testParseTaskGetNilWhenNoHead() {
        XCTAssertNil(parseTaskGet("just some text"))
    }

    func testParseTaskListRows() {
        let text = "#1 [pending] first subject\n#2 [in_progress] second (alice) [blocked by #1]"
        let rows = parseTaskListRows(text)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].id, "1")
        XCTAssertEqual(rows[0].status, "pending")
        XCTAssertEqual(rows[0].subject, "first subject")
        XCTAssertNil(rows[0].owner)
        XCTAssertEqual(rows[1].subject, "second")
        XCTAssertEqual(rows[1].owner, "alice")
        XCTAssertEqual(rows[1].blockedBy, "#1")
    }

    // MARK: - ToolSearch / delay (§2.6)

    func testParseToolSearchNamesDedupes() {
        let text = "<function>{\"name\":\"Read\"}</function><function>{\"name\":\"Grep\",\"parameters\":{\"name\":\"x\"}}</function>"
        XCTAssertEqual(parseToolSearchNames(text), ["Read", "Grep"])
    }

    func testFormatDelay() {
        XCTAssertEqual(formatDelay(45), "45s")
        XCTAssertEqual(formatDelay(2700), "45m")
        XCTAssertEqual(formatDelay(3660), "1h 1m")
        XCTAssertEqual(formatDelay(nil), "")
        XCTAssertEqual(formatDelay(0), "")
    }

    // MARK: - workflow (§3)

    func testPrettyValueReparsesJSONString() {
        let pretty = prettyValueJSON(.string("{\"b\":2,\"a\":1}"))
        XCTAssertTrue(pretty.contains("\"a\" : 1"))
        XCTAssertTrue(pretty.contains("\"b\" : 2"))
    }

    func testPrettyValuePassthroughNonJSON() {
        XCTAssertEqual(prettyValueJSON(.string("plain text")), "plain text")
    }

    func testParseWorkflowCompletion() {
        let c = parseWorkflowCompletion("[workflow run-9] completed (status: passed):\n{\"ok\":true}")
        XCTAssertEqual(c.runId, "run-9")
        XCTAssertEqual(c.status, "passed")
        XCTAssertEqual(c.body.trimmingCharacters(in: .whitespacesAndNewlines), "{\"ok\":true}")
    }

    func testParseWorkflowCompletionFallback() {
        let c = parseWorkflowCompletion("not a completion line", runIdFallback: "run-x")
        XCTAssertNil(c.status)
        XCTAssertEqual(c.runId, "run-x")
        XCTAssertEqual(c.body, "not a completion line")
    }

    func testWorkflowLabelRunStored() {
        let t = tool("mcp__orchestrator__workflow", input: ["mode": .string("run-stored"), "from": .string("nightly")])
        let (verb, file) = workflowLabel(t, running: false)
        XCTAssertEqual(verb, "Ran workflow")
        XCTAssertEqual(file, "nightly")
    }

    func testWorkflowStatusFromResult() {
        let t = tool("mcp__orchestrator__workflow", result: "{\"runId\":\"r\",\"status\":\"failed\"}")
        XCTAssertEqual(workflowStatus(t), "failed")
    }
}
