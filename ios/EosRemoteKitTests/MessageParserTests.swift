import XCTest
@testable import EosRemoteKit

// Port of app/ui/src/lib/messageParser.test.js — the regression harness for the event→block parser
// (spec 03 §4). Faithful mirror of the JS fixtures: clears/rewinds/recalls, tool lifecycle, lane
// grouping, agent-span folding, text coalescing, ask-answer attachment, ts sort, git verbs.
final class MessageParserTests: XCTestCase {

    // MARK: row/JSON helpers

    // A raw event row: JS tests use { type, ts, payload:{...} }. Payload may be an object or a
    // JSON string (the applyRewinds/applyClears fixtures serialize it) — toEv handles both.
    private func row(_ type: String, ts: Double, payload: [String: Any] = [:], id: Int? = nil, stringPayload: Bool = false) -> JSONValue {
        var obj: [String: JSONValue] = ["type": .string(type), "ts": .number(ts)]
        if let id { obj["id"] = .number(Double(id)) }
        if stringPayload {
            obj["payload"] = .string(jsonString(payload))
        } else {
            obj["payload"] = json(payload)
        }
        return .object(obj)
    }

    private func jsonString(_ any: Any) -> String {
        let data = try! JSONSerialization.data(withJSONObject: any)
        return String(decoding: data, as: UTF8.self)
    }
    private func json(_ any: Any) -> JSONValue {
        let data = try! JSONSerialization.data(withJSONObject: any)
        return try! JSONDecoder().decode(JSONValue.self, from: data)
    }

    private func build(_ rows: [JSONValue], bootPromptOffset: Int = 0) -> [Block] {
        MessageNormalizer.buildBlocks(rows, workerId: "w1", bootPromptOffset: bootPromptOffset)
    }

    // Common fixture rows (mirror the JS factory functions).
    private func agentRow(_ id: String, _ ts: Double) -> JSONValue {
        row("jsonl", ts: ts, payload: ["kind": "tool_use", "id": id, "name": "Agent", "input": ["description": id]])
    }
    private func toolRunning(_ toolUseId: String, _ ts: Double, parent: String? = nil) -> JSONValue {
        var p: [String: Any] = ["toolName": "Bash", "toolUseId": toolUseId, "input": ["command": "echo"]]
        if let parent { p["parentAgentToolUseId"] = parent }
        return row("tool_running", ts: ts, payload: p)
    }
    private func mainToolUse(_ id: String, _ ts: Double, _ name: String = "Read") -> JSONValue {
        row("jsonl", ts: ts, payload: ["kind": "tool_use", "id": id, "name": name, "input": ["file_path": "/x"]])
    }
    private func mainToolResult(_ toolUseId: String, _ ts: Double, _ text: String) -> JSONValue {
        row("jsonl", ts: ts, payload: ["kind": "tool_result", "toolUseId": toolUseId, "text": text, "isError": false])
    }
    private func mainToolDone(_ toolUseId: String, _ ts: Double, _ result: String, _ toolName: String = "Read") -> JSONValue {
        row("tool_done", ts: ts, payload: ["toolName": toolName, "toolUseId": toolUseId, "result": result])
    }
    private func agentEvent(_ ts: Double, _ event: [String: Any]) -> JSONValue {
        row("agent_event", ts: ts, payload: event)
    }
    private func subagentStarted(_ callId: String, _ agentId: String, _ ts: Double) -> JSONValue {
        agentEvent(ts, ["type": "subagent_started", "callId": callId, "agentId": agentId, "background": true])
    }
    private func subagentCompleted(_ agentId: String, _ ts: Double, _ extra: [String: Any] = [:]) -> JSONValue {
        var e: [String: Any] = ["type": "subagent_completed", "agentId": agentId, "status": "completed"]
        for (k, v) in extra { e[k] = v }
        return agentEvent(ts, e)
    }

    // Block accessors.
    private func toolsOf(_ blocks: [Block], _ agentToolUseId: String) -> [String] {
        for b in blocks { if case .agentRun(let run) = b.payload, run.toolUseId == agentToolUseId { return run.tools.map(\.id) } }
        return []
    }
    private func mainTool(_ blocks: [Block], _ id: String) -> Tool? {
        for b in blocks {
            if case .tool(let t) = b.payload, t.id == id { return t }
            if case .toolGroup(_, _, let tools) = b.payload, let t = tools.first(where: { $0.id == id }) { return t }
        }
        return nil
    }
    private func agentRun(_ blocks: [Block]) -> AgentRun? {
        for b in blocks { if case .agentRun(let run) = b.payload { return run } }
        return nil
    }
    // A compact kind tag per block, matching the JS `b.kind` strings used in the fixtures.
    private func kinds(_ blocks: [Block]) -> [String] { blocks.map(kindOf) }
    private func kindOf(_ b: Block) -> String {
        switch b.payload {
        case .user: return "user"; case .assistant: return "assistant"; case .thinking: return "thinking"
        case .tool: return "tool"; case .toolGroup: return "toolGroup"; case .agentRun: return "agentRun"
        case .report: return "report"; case .directive: return "directive"; case .peerRequest: return "peer-request"
        case .loop: return "loop"; case .loopCheck: return "loopCheck"; case .terminal: return "terminal"
        case .deliveryFailed: return "deliveryFailed"; case .cleared: return "cleared"; case .turnError: return "turnError"
        case .gitPush: return "push"; case .gitPull: return "pull"; case .worktreePreserved: return "worktreePreserved"
        }
    }

    // MARK: subagent attribution

    func testAttributesByParentForOverlappingSpans() {
        let events = [agentRow("idA", 100), agentRow("idB", 101), toolRunning("tA", 200, parent: "idA"), toolRunning("tB", 201, parent: "idB")]
        let blocks = build(events)
        XCTAssertEqual(toolsOf(blocks, "idA"), ["tA"])
        XCTAssertEqual(toolsOf(blocks, "idB"), ["tB"])
        XCTAssertFalse(blocks.contains { if case .tool(let t) = $0.payload { return t.id == "tA" || t.id == "tB" }; return false })
    }

    func testFallsBackToTimestampWindow() {
        let events = [agentRow("idA", 100), agentRow("idB", 101), toolRunning("tA", 200), toolRunning("tB", 201)]
        let blocks = build(events)
        let attributed = (toolsOf(blocks, "idA") + toolsOf(blocks, "idB")).sorted()
        XCTAssertEqual(attributed, ["tA", "tB"])
        XCTAssertFalse(blocks.contains { if case .tool(let t) = $0.payload { return t.id == "tA" || t.id == "tB" }; return false })
    }

    // MARK: skill_body attachment

    private func skillUse(_ id: String, _ ts: Double) -> JSONValue {
        row("jsonl", ts: ts, payload: ["kind": "tool_use", "id": id, "name": "Skill", "input": ["skill": "demo"]])
    }
    private func skillBody(_ toolUseId: String, _ ts: Double, _ text: String) -> JSONValue {
        row("jsonl", ts: ts, payload: ["kind": "skill_body", "toolUseId": toolUseId, "text": text])
    }
    func testAttachesSkillBodyById() {
        let blocks = build([skillUse("S1", 100), skillBody("S1", 101, "# Demo\nbody")])
        XCTAssertEqual(mainTool(blocks, "S1")?.skillBody, "# Demo\nbody")
    }
    func testSkillBodyNilWhenNoBodyEvent() {
        let blocks = build([skillUse("S1", 100)])
        XCTAssertNil(mainTool(blocks, "S1")?.skillBody)
    }
    func testExtractsSkillPathAndCleansBody() {
        let text = "Base directory for this skill: /s/demo\n\n# Demo\nbody"
        let t = mainTool(build([skillUse("S1", 100), skillBody("S1", 101, text)]), "S1")
        XCTAssertEqual(t?.skillPath, "/s/demo")
        XCTAssertEqual(t?.skillBody, "# Demo\nbody")
    }
    func testNilSkillPathWhenNoBaseDir() {
        let blocks = build([skillUse("S1", 100), skillBody("S1", 101, "# Demo\nbody")])
        XCTAssertNil(mainTool(blocks, "S1")?.skillPath)
    }

    // MARK: ask_peer peer name linking

    private func askPeer(_ toolUseId: String, _ peerId: String, _ ts: Double) -> JSONValue {
        row("tool_running", ts: ts, payload: ["toolName": "mcp__worker__ask_peer", "toolUseId": toolUseId, "input": ["peerId": peerId, "question": "help?"]])
    }
    private func askPeerByName(_ toolUseId: String, _ peerName: String, _ ts: Double) -> JSONValue {
        row("tool_running", ts: ts, payload: ["toolName": "mcp__worker__ask_peer", "toolUseId": toolUseId, "input": ["peerName": peerName, "question": "help?"]])
    }
    private func peerConsult(_ toWorker: String?, _ toName: String, _ ts: Double) -> JSONValue {
        var p: [String: Any] = ["requestId": "r1", "toName": toName, "question": "help?"]
        if let toWorker { p["toWorker"] = toWorker }
        return row("peer_consult", ts: ts, payload: p)
    }
    func testLinksConsultedPeerName() {
        let blocks = build([askPeer("ap1", "w2", 100), peerConsult("w2", "domain-expert", 101)])
        XCTAssertEqual(mainTool(blocks, "ap1")?.peerTo, AgentRef(id: "w2", name: "domain-expert"))
    }
    func testPeerToUnsetWithoutConsult() {
        XCTAssertNil(mainTool(build([askPeer("ap1", "w2", 100)]), "ap1")?.peerTo)
    }
    func testDoesNotMislinkDifferentPeer() {
        XCTAssertNil(mainTool(build([askPeer("ap1", "w2", 100), peerConsult("w9", "other", 101)]), "ap1")?.peerTo)
    }
    func testLinksByNameWhenConsultResolvesToWorker() {
        let blocks = build([askPeerByName("ap2", "data-analyst", 200), peerConsult("w5", "data-analyst", 201)])
        XCTAssertEqual(mainTool(blocks, "ap2")?.peerTo, AgentRef(id: "w5", name: "data-analyst"))
    }
    func testLinksByNameWhenConsultHasNoToWorker() {
        let blocks = build([askPeerByName("ap3", "data-analyst", 200), peerConsult(nil, "data-analyst", 201)])
        XCTAssertEqual(mainTool(blocks, "ap3")?.peerTo, AgentRef(id: nil, name: "data-analyst"))
    }
    func testDoesNotMislinkByNameDifferentName() {
        XCTAssertNil(mainTool(build([askPeerByName("ap4", "data-analyst", 200), peerConsult("w9", "other-peer", 201)]), "ap4")?.peerTo)
    }

    // MARK: main-agent tool_done fallback

    func testToolDoneFallbackClearsStuckTool() {
        let events = [mainToolUse("T1", 100), mainToolUse("T2", 101), mainToolResult("T1", 102, "T1 jsonl"),
                      mainToolDone("T1", 103, "T1 hook"), mainToolDone("T2", 104, "T2 hook")]
        let t2 = mainTool(build(events), "T2")
        XCTAssertEqual(t2?.done, true)
        XCTAssertEqual(t2?.result, ToolResult(text: "T2 hook", isError: false))
    }
    func testJsonlResultWinsOverToolDone() {
        let events = [mainToolUse("T1", 100), mainToolResult("T1", 101, "jsonl text"), mainToolDone("T1", 102, "hook text")]
        let t1 = mainTool(build(events), "T1")
        XCTAssertEqual(t1?.result?.text, "jsonl text")
        XCTAssertEqual(t1?.done, true)
    }
    func testToolRunningWhenNeitherPresent() {
        let t1 = mainTool(build([mainToolUse("T1", 100)]), "T1")
        XCTAssertNil(t1?.result)
        XCTAssertEqual(t1?.done, false)
        XCTAssertEqual(t1?.running, true)
    }
    func testFailedToolDoneMarkedError() {
        let events = [mainToolUse("T1", 100), row("tool_done", ts: 101, payload: ["toolName": "Read", "toolUseId": "T1", "result": "boom", "isError": true])]
        let t1 = mainTool(build(events), "T1")
        XCTAssertEqual(t1?.running, false)
        XCTAssertEqual(t1?.result, ToolResult(text: "boom", isError: true))
    }
    func testAskAnswerWinsOverToolDone() {
        let events = [mainToolUse("Q1", 100, "AskUserQuestion"), mainToolDone("Q1", 101, "hook text", "AskUserQuestion"),
                      row("user_message", ts: 102, payload: ["text": "My answers to your questions: yes"])]
        let q1 = mainTool(build(events), "Q1")
        XCTAssertEqual(q1?.done, true)
        XCTAssertEqual(q1?.running, false)
        XCTAssertEqual(q1?.result?.text.hasPrefix("My answers to your questions:"), true)
    }

    // MARK: lifecycle barriers

    private func stop(_ ts: Double) -> JSONValue { row("hook", ts: ts, payload: ["event": "Stop"]) }
    private func idle(_ ts: Double, _ reason: String) -> JSONValue { row("state", ts: ts, payload: ["state": "IDLE", "from": "WORKING", "reason": reason]) }
    private func exit(_ ts: Double, _ code: Int = 143) -> JSONValue { row("exit", ts: ts, payload: ["code": code]) }

    func testClosesToolOnTurnEnd() {
        let t1 = mainTool(build([mainToolUse("T1", 100), stop(101)]), "T1")
        XCTAssertEqual(t1?.running, false)
        XCTAssertNil(t1?.result)
    }
    func testClosesToolOnIdleInterrupt() {
        XCTAssertEqual(mainTool(build([mainToolUse("T1", 100), idle(101, "interrupt")]), "T1")?.running, false)
    }
    func testClosesHookOnlyToolOnExit() {
        let events = [row("tool_running", ts: 100, payload: ["toolName": "Bash", "toolUseId": "B1", "input": [:]]), exit(101)]
        XCTAssertEqual(mainTool(build(events), "B1")?.running, false)
    }
    func testKeepsToolRunningWhenBarrierPrecedes() {
        XCTAssertEqual(mainTool(build([stop(99), mainToolUse("T1", 100)]), "T1")?.running, true)
    }
    func testBackgroundInnerToolsSurviveTurnEnd() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), mainToolResult("AG", 101, "launch stub"),
                      toolRunning("I1", 102, parent: "AG"), stop(103)]
        let run = agentRun(build(events))
        XCTAssertEqual(run?.status, "running")
        XCTAssertEqual(run?.tools.first?.running, true)
    }
    func testClosesBackgroundAgentAndInnerToolsOnExit() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), mainToolResult("AG", 101, "launch stub"),
                      toolRunning("I1", 102, parent: "AG"), exit(103)]
        let run = agentRun(build(events))
        XCTAssertEqual(run?.status, "completed")
        XCTAssertEqual(run?.tools.first?.running, false)
    }
    func testBackgroundAgentStaysRunningAfterInnerToolsFinish() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), toolRunning("I1", 102, parent: "AG"), mainToolDone("I1", 103, "ok", "Bash")]
        XCTAssertEqual(agentRun(build(events))?.status, "running")
    }
    func testClosesForegroundAgentKilledMidRun() {
        XCTAssertEqual(agentRun(build([agentRow("AG", 100), exit(101)]))?.status, "completed")
    }

    // MARK: foreground agentRun closes on tool_result

    func testForegroundAgentCompletesFromResultNoBarrier() {
        let run = agentRun(build([agentRow("AG", 100), mainToolResult("AG", 101, "the subagent summary")]))
        XCTAssertEqual(run?.status, "completed")
        XCTAssertEqual(run?.result, "the subagent summary")
        XCTAssertEqual(run?.background, false)
    }
    func testBackgroundAgentFlaggedFromStartedIgnoringStub() {
        let run = agentRun(build([agentRow("AG", 100), subagentStarted("AG", "a1", 101), mainToolResult("AG", 101, "launch stub")]))
        XCTAssertEqual(run?.background, true)
        XCTAssertEqual(run?.status, "running")
        XCTAssertNil(run?.result)
    }

    // MARK: canonical background-subagent lifecycle

    func testFlipsOnlyAtSubagentCompleted() {
        let before = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), mainToolResult("AG", 101, "launch stub"),
                      toolRunning("I1", 102, parent: "AG"), mainToolDone("I1", 103, "ok", "Bash"), stop(104)]
        let running = agentRun(build(before))
        XCTAssertEqual(running?.status, "running")
        XCTAssertNil(running?.result)
        let done = agentRun(build(before + [subagentCompleted("a1", 200, ["callId": "AG", "result": "final agent output"])]))
        XCTAssertEqual(done?.status, "completed")
        XCTAssertEqual(done?.result, "final agent output")
    }
    func testTakesLatestCompletion() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101),
                      subagentCompleted("a1", 200, ["callId": "AG", "result": "short summary"]),
                      subagentCompleted("a1", 210, ["callId": "AG", "result": "full final text"])]
        let runs = build(events).filter { if case .agentRun = $0.payload { return true }; return false }
        XCTAssertEqual(runs.count, 1)
        if case .agentRun(let run) = runs[0].payload {
            XCTAssertEqual(run.status, "completed")
            XCTAssertEqual(run.result, "full final text")
        }
    }
    func testFreezesToolListAfterCompletion() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), toolRunning("I1", 102, parent: "AG"),
                      subagentCompleted("a1", 200, ["callId": "AG", "result": "out"]), toolRunning("STRAY", 300)]
        let blocks = build(events)
        XCTAssertEqual(toolsOf(blocks, "AG"), ["I1"])
        XCTAssertTrue(blocks.contains { if case .tool(let t) = $0.payload { return t.id == "STRAY" }; return false })
    }
    func testCorrelatesCompletionByAgentId() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), subagentCompleted("a1", 200, ["result": "matched via agentId"])]
        let run = agentRun(build(events))
        XCTAssertEqual(run?.status, "completed")
        XCTAssertEqual(run?.result, "matched via agentId")
    }
    func testPassesFailedStatus() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), subagentCompleted("a1", 200, ["callId": "AG", "status": "failed", "result": "boom"])]
        let run = agentRun(build(events))
        XCTAssertEqual(run?.status, "failed")
        XCTAssertEqual(run?.result, "boom")
    }
    func testClosesAtSessionExitNoCompletion() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), toolRunning("I1", 102, parent: "AG"), exit(300, 0)]
        XCTAssertEqual(agentRun(build(events))?.status, "completed")
    }
    func testCompletesWithNilResult() {
        let events = [agentRow("AG", 100), subagentStarted("AG", "a1", 101), subagentCompleted("a1", 200, ["callId": "AG"])]
        let run = agentRun(build(events))
        XCTAssertEqual(run?.status, "completed")
        XCTAssertNil(run?.result)
    }

    // MARK: subagent via spawnsSubagent marker (in-process lane)

    func testFoldsMarkerToolCallAndAttachesInnerTools() {
        let events = [
            agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "tool_call", "callId": "task-1", "name": "Task", "input": ["subagent_type": "general-purpose", "description": "do a thing", "prompt": "go"], "spawnsSubagent": true]]]),
            agentEvent(101, ["type": "activity", "kind": "tool_started", "callId": "inner-1", "toolName": "Bash", "input": ["command": "ls"], "parentCallId": "task-1"]),
            agentEvent(102, ["type": "activity", "kind": "tool_finished", "callId": "inner-1", "result": "files", "isError": false]),
            agentEvent(103, ["type": "message", "role": "tool", "blocks": [["type": "tool_result", "callId": "task-1", "isError": false, "content": "sub summary"]]]),
        ]
        let blocks = build(events)
        let run = agentRun(blocks)
        XCTAssertNotNil(run)
        XCTAssertEqual(run?.status, "completed")
        XCTAssertEqual(run?.result, "sub summary")
        XCTAssertEqual(run?.subagentType, "general-purpose")
        XCTAssertEqual(run?.tools.map(\.id), ["inner-1"])
        XCTAssertEqual(run?.tools.first?.name, "Bash")
        XCTAssertEqual(run?.tools.first?.done, true)
        XCTAssertFalse(blocks.contains { if case .tool(let t) = $0.payload { return t.id == "inner-1" || t.id == "task-1" }; return false })
    }

    func testFoldsAgentByNameLegacy() {
        let events = [
            agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "tool_call", "callId": "ag-1", "name": "Agent", "input": ["description": "legacy"]]]]),
            agentEvent(101, ["type": "activity", "kind": "tool_started", "callId": "inner-9", "toolName": "Read", "input": ["file_path": "/x"], "parentCallId": "ag-1"]),
            agentEvent(102, ["type": "message", "role": "tool", "blocks": [["type": "tool_result", "callId": "ag-1", "isError": false, "content": "done"]]]),
        ]
        XCTAssertEqual(agentRun(build(events))?.tools.map(\.id), ["inner-9"])
    }

    // MARK: standalone tools

    func testStandaloneSplitsSurroundingGroup() {
        let events = [mainToolUse("T1", 100), mainToolUse("T2", 101), mainToolUse("S1", 102, "Skill"), mainToolUse("T3", 103), mainToolUse("T4", 104)]
        let blocks = build(events)
        XCTAssertEqual(kinds(blocks), ["toolGroup", "tool", "toolGroup"])
        if case .toolGroup(_, _, let t0) = blocks[0].payload { XCTAssertEqual(t0.map(\.id), ["T1", "T2"]) }
        if case .tool(let s1) = blocks[1].payload { XCTAssertEqual(s1.id, "S1") }
        if case .toolGroup(_, _, let t2) = blocks[2].payload { XCTAssertEqual(t2.map(\.id), ["T3", "T4"]) }
    }
    func testStandaloneAloneBetweenGroupableRunning() {
        let events = [row("tool_running", ts: 100, payload: ["toolName": "Bash", "toolUseId": "B1", "input": [:]]),
                      row("tool_running", ts: 101, payload: ["toolName": "AskUserQuestion", "toolUseId": "Q1", "input": [:]]),
                      row("tool_running", ts: 102, payload: ["toolName": "Bash", "toolUseId": "B2", "input": [:]])]
        let blocks = build(events)
        XCTAssertEqual(kinds(blocks), ["tool", "tool", "tool"])
        if case .tool(let q) = blocks[1].payload { XCTAssertEqual(q.name, "AskUserQuestion") }
    }
    func testHookOnlyAgentStaysStandalone() {
        let events = [row("tool_running", ts: 100, payload: ["toolName": "Bash", "toolUseId": "B1", "input": [:]]),
                      row("tool_running", ts: 101, payload: ["toolName": "Agent", "toolUseId": "A1", "input": [:]]),
                      row("tool_running", ts: 102, payload: ["toolName": "Bash", "toolUseId": "B2", "input": [:]])]
        let blocks = build(events)
        XCTAssertEqual(kinds(blocks), ["tool", "tool", "tool"])
        if case .tool(let a) = blocks[1].payload { XCTAssertEqual(a.name, "Agent") }
    }

    // MARK: worker-tool lane

    private func kill(_ id: String, _ ts: Double) -> JSONValue { mainToolUse(id, ts, "mcp__orchestrator__kill_worker") }
    private func spawn(_ id: String, _ ts: Double) -> JSONValue { mainToolUse(id, ts, "mcp__orchestrator__spawn_worker") }

    func testCollapsesWorkerToolsWithSummary() {
        let blocks = build([kill("K1", 100), kill("K2", 101), kill("K3", 102)])
        XCTAssertEqual(kinds(blocks), ["toolGroup"])
        if case .toolGroup(let lane, let summary, let tools) = blocks[0].payload {
            XCTAssertEqual(lane, .worker)
            XCTAssertEqual(tools.map(\.id), ["K1", "K2", "K3"])
            XCTAssertEqual(summary, "Killed 3 workers")
        }
    }
    func testMixedWorkerToolsSummary() {
        let blocks = build([spawn("S1", 100), spawn("S2", 101), kill("K1", 102)])
        if case .toolGroup(_, let summary, _) = blocks[0].payload { XCTAssertEqual(summary, "Spawned 2 workers, killed 1 worker") }
    }
    func testLaneChangeSplitsRun() {
        let events = [mainToolUse("T1", 100), mainToolUse("T2", 101), kill("K1", 102), kill("K2", 103), mainToolUse("T3", 104)]
        let blocks = build(events)
        XCTAssertEqual(kinds(blocks), ["toolGroup", "toolGroup", "tool"])
        if case .toolGroup(let l0, _, _) = blocks[0].payload { XCTAssertEqual(l0, .generic) }
        if case .toolGroup(let l1, _, let t1) = blocks[1].payload { XCTAssertEqual(l1, .worker); XCTAssertEqual(t1.map(\.id), ["K1", "K2"]) }
        if case .tool(let t3) = blocks[2].payload { XCTAssertEqual(t3.id, "T3") }
    }
    func testLoneWorkerToolStandalone() {
        let blocks = build([kill("K1", 100)])
        XCTAssertEqual(kinds(blocks), ["tool"])
        if case .tool(let k) = blocks[0].payload { XCTAssertEqual(k.id, "K1") }
    }
    func testBuildWorkerSummaryPhrasing() {
        func t(_ name: String) -> Tool { Tool(id: "", name: name, verb: "read", input: .object([:]), running: false, done: true, ts: 0) }
        XCTAssertEqual(buildWorkerSummary([t("mcp__orchestrator__list_active_workers"), t("mcp__orchestrator__list_active_workers")]), "Listed workers ×2")
        XCTAssertEqual(buildWorkerSummary([t("mcp__orchestrator__get_worker"), t("mcp__orchestrator__list_pending_permissions")]), "Checked 1 worker, checked pending permissions")
    }

    // MARK: gitActions

    private func bashTool(_ command: String, _ resultText: String? = nil, _ isError: Bool = false) -> Tool {
        Tool(id: "b", name: "Bash", verb: "bash", input: .object(["command": .string(command)]),
             result: resultText.map { ToolResult(text: $0, isError: isError) }, running: false, done: true, ts: 0)
    }
    func testGitVerbs() {
        XCTAssertEqual(gitActions(bashTool("git push origin dev")).map(\.verb), ["Pushed"])
        XCTAssertEqual(gitActions(bashTool("git merge feature-x")).map(\.verb), ["Merged"])
        XCTAssertEqual(gitActions(bashTool("cd /x && git -C /y rebase main")).map(\.verb), ["Rebased"])
    }
    func testGitCompound() {
        XCTAssertEqual(gitActions(bashTool("git add -A && git commit -m \"x\" && git push")).map(\.verb), ["Staged", "Committed", "Pushed"])
    }
    func testGitReadOnlyNonActions() {
        XCTAssertEqual(gitActions(bashTool("git status && git log --oneline")).count, 0)
    }
    func testGitDiffViewed() {
        XCTAssertEqual(gitActions(bashTool("git diff main..dev")).map(\.verb), ["Viewed diff"])
    }
    func testGitIgnoresQuoted() {
        XCTAssertEqual(gitActions(bashTool("echo \"run git push later\"")).count, 0)
        XCTAssertEqual(gitActions(bashTool("git commit -m \"git merge notes\"")).map(\.sub), ["commit"])
    }
    func testGitExtractsShas() {
        XCTAssertEqual(gitActions(bashTool("git commit -m \"msg\"", "[dev fbce36a] msg\n 1 file changed")).first?.shas, ["fbce36a"])
    }
    func testGitNoActionsForFailed() {
        XCTAssertEqual(gitActions(bashTool("git push", "rejected", true)).count, 0)
    }
    func testGitStripsFlagsRedirs() {
        XCTAssertEqual(gitActions(bashTool("git push -u origin dev 2>&1")).first?.detail, "origin dev")
    }

    // MARK: buildSummary git awareness

    func testSummaryGitAware() {
        let tools = [Tool(id: "r", name: "Read", verb: "read", input: .object([:]), running: false, done: true, ts: 0),
                     bashTool("git commit -m \"x\"", "[dev abc1234] x"), bashTool("git push"), bashTool("npm test")]
        XCTAssertEqual(buildSummary(tools), "Read 1 file, Committed abc1234, Pushed, ran 1 shell command")
    }
    func testSummaryMergesShas() {
        let tools = [bashTool("git commit -m \"a\"", "[dev aaa1111] a"), bashTool("git commit -m \"b\"", "[dev bbb2222] b")]
        XCTAssertEqual(buildSummary(tools), "Committed aaa1111, bbb2222")
    }
    func testSummaryShellOnly() {
        XCTAssertEqual(buildSummary([bashTool("ls"), bashTool("npm run build")]), "ran 2 shell commands")
    }
    func testSummaryCountsRepeatedDiffs() {
        let tools = [bashTool("git diff a.ts"), bashTool("git diff b.ts && git diff c.ts && git diff d.ts"), bashTool("git diff e.ts f.ts")]
        XCTAssertEqual(buildSummary(tools), "Viewed 5 diffs")
    }

    // MARK: applyRewinds (string payloads, mirroring the JS fixtures)

    private func userS(_ text: String, _ ts: Double) -> JSONValue { row("user_message", ts: ts, payload: ["text": text], stringPayload: true) }
    private func asstS(_ text: String, _ ts: Double) -> JSONValue { row("jsonl", ts: ts, payload: ["kind": "assistant_text", "text": text], stringPayload: true) }
    private func rewound(_ payload: [String: Any], _ ts: Double) -> JSONValue { row("conversation_rewound", ts: ts, payload: payload, stringPayload: true) }

    private func tsList(_ evs: [Ev]) -> [Double] { evs.map(\.ts) }

    func testRewindPassthrough() {
        let events = [userS("hello", 1), asstS("hi", 2)].map(toEv)
        XCTAssertEqual(tsList(applyRewinds(events)), [1, 2])
    }
    func testRewindCutsFromMatchingUser() {
        let events = [userS("first", 1), asstS("r1", 2), userS("second", 3), asstS("r2", 4),
                      rewound(["text": "second", "display": "second", "index": 1], 5)].map(toEv)
        XCTAssertEqual(tsList(applyRewinds(events)), [1, 2])
    }
    func testRewindMatchesLastOccurrence() {
        let events = [userS("same", 1), asstS("r1", 2), userS("same", 3), asstS("r2", 4),
                      rewound(["text": "same", "display": "same", "index": 1], 5)].map(toEv)
        XCTAssertEqual(tsList(applyRewinds(events)), [1, 2])
    }
    func testRewindToleratesAttachmentSuffix() {
        let events = [userS("fix the bug [Image #1]", 1), asstS("done", 2),
                      rewound(["text": "fix the bug", "display": "fix the bug", "index": 0], 3)].map(toEv)
        XCTAssertEqual(applyRewinds(events).count, 0)
    }
    func testRewindFallsBackToIndex() {
        let events = [userS("hello", 1), asstS("hi", 2), userS("/commit", 3), asstS("committed", 4),
                      rewound(["text": "FULL COMMIT TEMPLATE …", "display": "FULL COMMIT TEMPLATE …", "index": 1], 5)].map(toEv)
        XCTAssertEqual(tsList(applyRewinds(events)), [1, 2])
    }
    func testRewindBootPromptOffset() {
        let events = [userS("hello", 1), asstS("hi", 2), rewound(["text": "NO MATCH", "display": "NO MATCH", "index": 1], 3)].map(toEv)
        XCTAssertEqual(applyRewinds(events, bootPromptOffset: 1).count, 0)
    }
    func testRewindNoCutPoint() {
        let events = [userS("hello", 1), rewound(["text": "NO MATCH", "display": "NO MATCH"], 2)].map(toEv)
        XCTAssertEqual(tsList(applyRewinds(events)), [1])
    }
    func testRewindSequential() {
        let events = [userS("a", 1), asstS("ra", 2), userS("b", 3), asstS("rb", 4),
                      rewound(["text": "b", "display": "b", "index": 1], 5),
                      userS("b2", 6), asstS("rb2", 7), rewound(["text": "b2", "display": "b2", "index": 1], 8)].map(toEv)
        XCTAssertEqual(tsList(applyRewinds(events)), [1, 2])
    }

    // MARK: applyClears

    private func clearedRow(_ ts: Double) -> JSONValue { row("conversation_cleared", ts: ts, payload: [:], stringPayload: true) }
    func testClearsPassthrough() {
        let events = [userS("hello", 1), asstS("hi", 2)].map(toEv)
        XCTAssertEqual(tsList(applyClears(events)), [1, 2])
    }
    func testClearsDropsBeforeMarker() {
        let events = [userS("/clear", 1), asstS("old", 2), clearedRow(3), userS("fresh", 4)].map(toEv)
        XCTAssertEqual(tsList(applyClears(events)), [3, 4])
    }
    func testClearsCutsAtLastMarker() {
        let events = [userS("a", 1), clearedRow(2), userS("b", 3), clearedRow(4), userS("c", 5)].map(toEv)
        XCTAssertEqual(tsList(applyClears(events)), [4, 5])
    }
    func testClearsRendersDivider() {
        let blocks = build([userS("old", 1), clearedRow(2), userS("new", 3)])
        XCTAssertEqual(kinds(blocks), ["cleared", "user"])
    }

    // MARK: applyRecalls

    private func evRow(_ id: Int, _ type: String, _ payload: [String: Any]) -> JSONValue { row(type, ts: Double(id), payload: payload, id: id, stringPayload: true) }
    private func idList(_ evs: [Ev]) -> [Int] { evs.compactMap { $0.payload["__rowId"]?.intValue } }

    func testRecallsByRowId() {
        let events = [evRow(1, "user_message", ["text": "older", "clientMsgIds": ["c0"]]),
                      evRow(5, "user_message", ["text": "recalled", "clientMsgIds": ["c1"]]),
                      evRow(6, "message_recalled", ["text": "recalled", "clientMsgId": "c1", "recalledRowId": 5])].map(toEv)
        XCTAssertEqual(idList(applyRecalls(events)), [1])
    }
    func testRecallsByClientMsgId() {
        let events = [evRow(5, "user_message", ["text": "recalled", "clientMsgIds": ["c1"]]),
                      evRow(6, "message_recalled", ["text": "recalled", "clientMsgId": "c1"])].map(toEv)
        XCTAssertEqual(applyRecalls(events).count, 0)
    }
    func testRecallsNoOpWithoutMarker() {
        let events = [evRow(1, "user_message", ["text": "hi", "clientMsgIds": ["c1"]])].map(toEv)
        XCTAssertEqual(applyRecalls(events).count, 1)
    }
    func testRecallsLeavesUnrelated() {
        let events = [evRow(1, "user_message", ["text": "keep", "clientMsgIds": ["cA"]]),
                      evRow(2, "agent_event", ["type": "message"]),
                      evRow(3, "user_message", ["text": "gone", "clientMsgIds": ["cB"]]),
                      evRow(4, "message_recalled", ["text": "gone", "clientMsgId": "cB", "recalledRowId": 3])].map(toEv)
        XCTAssertEqual(idList(applyRecalls(events)), [1, 2])
    }

    // MARK: chat ordering (sentAt + sortBlocksByTs)

    private func thinkingS(_ text: String, _ ts: Double) -> JSONValue { row("jsonl", ts: ts, payload: ["kind": "thinking", "text": text], stringPayload: true) }
    private func userAt(_ text: String, _ ts: Double, _ sentAt: Double) -> JSONValue { row("user_message", ts: ts, payload: ["text": text, "sentAt": sentAt], stringPayload: true) }

    func testUserTsPrefersSentAt() {
        let blocks = build([userAt("hi", 500, 100)])
        XCTAssertEqual(kindOf(blocks[0]), "user")
        XCTAssertEqual(blocks[0].ts, 100)
    }
    func testUserTsFallsBackToEventTs() {
        let blocks = build([row("user_message", ts: 500, payload: ["text": "hi"], stringPayload: true)])
        XCTAssertEqual(blocks[0].ts, 500)
    }
    func testLateBubbleSortsAboveOutput() {
        let events = [thinkingS("hmm", 200), asstS("out", 210), userAt("do it", 300, 150)]
        XCTAssertEqual(kinds(build(events)), ["user", "thinking", "assistant"])
    }
    func testSameTsKeepsOrder() {
        let events = [thinkingS("a", 100), asstS("b", 100), userAt("c", 100, 100)]
        XCTAssertEqual(kinds(build(events)), ["thinking", "assistant", "user"])
    }

    // MARK: creation-domain ordering

    private func asstAt(_ text: String, _ ts: Double, _ tsTranscript: Double) -> JSONValue {
        row("jsonl", ts: ts, payload: ["kind": "assistant_text", "text": text, "tsTranscript": tsTranscript], stringPayload: true)
    }
    private func userMsg(_ text: String, _ ts: Double, _ extra: [String: Any] = [:]) -> JSONValue {
        var p: [String: Any] = ["text": text]; for (k, v) in extra { p[k] = v }
        return row("user_message", ts: ts, payload: p, stringPayload: true)
    }

    func testDrainedQueueAfterTrailingOutput() {
        let events = [asstAt("final output", 2300, 1000), userMsg("queued msg", 2600, ["sentAt": 2000, "anchorTs": 2500])]
        XCTAssertEqual(kinds(build(events)), ["assistant", "user"])
    }
    func testBubbleAboveOutputNewTurn() {
        let events = [userMsg("go", 4000, ["sentAt": 2000, "anchorTs": 2500]), asstAt("response", 4100, 3000)]
        XCTAssertEqual(kinds(build(events)), ["user", "assistant"])
    }
    func testBlocksPreferTsTranscript() {
        let events = [row("jsonl", ts: 900, payload: ["kind": "thinking", "text": "t", "tsTranscript": 500], stringPayload: true),
                      asstAt("a", 901, 510),
                      row("jsonl", ts: 902, payload: ["kind": "tool_use", "id": "T1", "name": "Read", "input": [:], "tsTranscript": 520], stringPayload: true)]
        let blocks = build(events)
        XCTAssertEqual(blocks.first { kindOf($0) == "thinking" }?.ts, 500)
        XCTAssertEqual(blocks.first { kindOf($0) == "assistant" }?.ts, 510)
        XCTAssertEqual(blocks.first { kindOf($0) == "tool" }?.ts, 520)
    }
    func testAnchorChainFallback() {
        XCTAssertEqual(build([userMsg("x", 300, ["sentAt": 150, "anchorTs": 250])])[0].ts, 250)
        XCTAssertEqual(build([userMsg("x", 300, ["sentAt": 150])])[0].ts, 150)
        XCTAssertEqual(build([userMsg("x", 300)])[0].ts, 300)
    }
    func testReportDirectiveAnchorChain() {
        let rep = build([row("worker_report", ts: 300, payload: ["text": "r", "sentAt": 100, "anchorTs": 200], stringPayload: true)])
        let dir = build([row("orchestrator_message", ts: 300, payload: ["text": "d", "sentAt": 100, "anchorTs": 200], stringPayload: true)])
        XCTAssertEqual(rep[0].ts, 200)
        XCTAssertEqual(dir[0].ts, 200)
    }

    // MARK: canonical agent_event decoder

    func testFinishedDurableTurnFromAgentEvent() {
        let events = [
            agentEvent(100, ["type": "message", "role": "assistant", "blocks": [
                ["type": "reasoning", "text": "let me think", "blockId": "u1:0"],
                ["type": "text", "text": "the answer is 42", "blockId": "u1:1"],
                ["type": "tool_call", "callId": "c1", "name": "Read", "input": ["file_path": "/x"]]]]),
            agentEvent(101, ["type": "message", "role": "tool", "blocks": [["type": "tool_result", "callId": "c1", "content": "file contents", "isError": false]]]),
            agentEvent(101, ["type": "activity", "kind": "tool_finished", "callId": "c1", "result": "file contents"]),
        ]
        let blocks = build(events)
        XCTAssertEqual(kinds(blocks), ["thinking", "assistant", "tool"])
        if case .thinking(let t) = blocks[0].payload { XCTAssertEqual(t, "let me think") }
        XCTAssertEqual(blocks[0].blockId, "u1:0")
        if case .assistant(let a) = blocks[1].payload { XCTAssertEqual(a, "the answer is 42") }
        XCTAssertEqual(blocks[1].blockId, "u1:1")
        let tool = mainTool(blocks, "c1")
        XCTAssertEqual(tool?.name, "Read")
        XCTAssertEqual(tool?.running, false)
        XCTAssertEqual(tool?.done, true)
        XCTAssertEqual(tool?.result, ToolResult(text: "file contents", isError: false))
    }
    func testSkipsEmptyReasoning() {
        let blocks = build([agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "reasoning", "text": "   "], ["type": "text", "text": "hi"]]])])
        XCTAssertFalse(blocks.contains { kindOf($0) == "thinking" })
        if case .assistant(let a) = blocks.first(where: { kindOf($0) == "assistant" })!.payload { XCTAssertEqual(a, "hi") }
    }
    func testCarriesPatchToToolResult() {
        let patch: [Any] = [["oldStart": 35, "newStart": 35, "lines": ["-b", "+x"]]]
        let events = [
            agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "tool_call", "callId": "e1", "name": "Edit", "input": ["file_path": "/x"]]]]),
            agentEvent(101, ["type": "message", "role": "tool", "blocks": [["type": "tool_result", "callId": "e1", "content": "ok", "isError": false, "patch": patch]]]),
        ]
        let tool = mainTool(build(events), "e1")
        XCTAssertEqual(tool?.result?.patch, json(patch))
    }
    func testPatchNilWhenAbsent() {
        let events = [
            agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "tool_call", "callId": "r1", "name": "Read", "input": ["file_path": "/x"]]]]),
            agentEvent(101, ["type": "message", "role": "tool", "blocks": [["type": "tool_result", "callId": "r1", "content": "data", "isError": false]]]),
        ]
        XCTAssertNil(mainTool(build(events), "r1")?.result?.patch)
    }
    func testDropsDeltaAndTurnStartedBareToolStartedRuns() {
        let empty = build([agentEvent(100, ["type": "delta", "channel": "reasoning", "phase": "append", "blockId": "u1:0", "text": "tok"]),
                           agentEvent(101, ["type": "turn", "phase": "started"])])
        XCTAssertEqual(empty.count, 0)
        let live = build([agentEvent(102, ["type": "activity", "kind": "tool_started", "callId": "c1", "toolName": "Read"])])
        XCTAssertEqual(kinds(live), ["tool"])
        let tool = mainTool(live, "c1")
        XCTAssertEqual(tool?.name, "Read")
        XCTAssertEqual(tool?.running, true)
        XCTAssertEqual(tool?.done, false)
    }
    func testIgnoresRoleUserMessages() {
        XCTAssertEqual(build([agentEvent(100, ["type": "message", "role": "user", "blocks": [["type": "text", "text": "hello"]]])]).count, 0)
    }
    func testInterleavesCanonicalWithTimeline() {
        let events = [row("user_message", ts: 90, payload: ["text": "do it", "anchorTs": 90]),
                      agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "text", "text": "done", "blockId": "u1:0"]]])]
        let blocks = build(events)
        XCTAssertEqual(kinds(blocks), ["user", "assistant"])
        if case .assistant(let a) = blocks[1].payload { XCTAssertEqual(a, "done") }
    }
    func testGroupsParentedInnerToolsUnderAgentRun() {
        let events = [
            agentEvent(100, ["type": "message", "role": "assistant", "blocks": [["type": "tool_call", "callId": "agent_1", "name": "Agent", "input": ["description": "sub"]]]]),
            agentEvent(101, ["type": "activity", "kind": "tool_started", "callId": "inner_1", "toolName": "Bash", "input": ["command": "find ."], "parentCallId": "agent_1"]),
            agentEvent(102, ["type": "activity", "kind": "tool_finished", "callId": "inner_1", "result": "found"]),
            agentEvent(103, ["type": "message", "role": "tool", "blocks": [["type": "tool_result", "callId": "agent_1", "content": "report"]]]),
        ]
        let blocks = build(events)
        let run = agentRun(blocks)
        XCTAssertNotNil(run)
        XCTAssertFalse(blocks.contains { if case .tool(let t) = $0.payload { return t.name == "Bash" }; return false })
        let inner = run?.tools.first { $0.id == "inner_1" }
        XCTAssertEqual(inner?.name, "Bash")
        XCTAssertEqual(inner?.result?.text, "found")
    }

    // MARK: dynamic-loop + loop_check + turn_error

    func testLoopContinuationBlock() {
        let blocks = build([row("loop_continuation", ts: 100, payload: ["text": "[DYNAMIC LOOP — AUTOMATED GOAL-CHECK] keep working"])])
        let loop = blocks.first { kindOf($0) == "loop" }
        XCTAssertNotNil(loop)
        if case .loop(let text) = loop!.payload { XCTAssertTrue(text.contains("keep working")) }
        XCTAssertFalse(blocks.contains { kindOf($0) == "user" })
    }
    func testLoopCheckBlock() {
        let blocks = build([row("loop_check", ts: 100, payload: ["attempt": 2, "maxAttempts": 5, "strategy": "hybrid", "met": false, "outcome": "continued", "reason": "unmet: c1"])])
        let lc = blocks.first { kindOf($0) == "loopCheck" }
        XCTAssertNotNil(lc)
        if case .loopCheck(let check) = lc!.payload {
            XCTAssertEqual(check.attempt, 2); XCTAssertEqual(check.maxAttempts, 5); XCTAssertEqual(check.strategy, "hybrid")
            XCTAssertEqual(check.met, false); XCTAssertEqual(check.outcome, "continued"); XCTAssertEqual(check.reason, "unmet: c1")
        }
        XCTAssertEqual(lc?.ts, 100)
    }
    func testLoopCheckSparse() {
        let blocks = build([row("loop_check", ts: 200, payload: ["attempt": 1, "maxAttempts": NSNull(), "strategy": "command", "met": true, "outcome": "released"])])
        if case .loopCheck(let check) = blocks.first(where: { kindOf($0) == "loopCheck" })!.payload {
            XCTAssertEqual(check.attempt, 1); XCTAssertNil(check.maxAttempts); XCTAssertEqual(check.met, true)
            XCTAssertEqual(check.outcome, "released"); XCTAssertEqual(check.reason, "")
        }
    }
    private func turnError(_ reason: String, _ ts: Double = 100) -> JSONValue { agentEvent(ts, ["type": "turn", "phase": "error", "reason": reason]) }
    func testTurnErrorInsufficientCredits() {
        let te = build([turnError("insufficient_credits")]).first { kindOf($0) == "turnError" }
        XCTAssertNotNil(te)
        if case .turnError(let reason, let message) = te!.payload {
            XCTAssertEqual(reason, "insufficient_credits")
            XCTAssertEqual(message, providerErrorMessage("insufficient_credits"))
            XCTAssertTrue(message.range(of: "credits", options: .caseInsensitive) != nil)
        }
    }
    func testTurnErrorAuthInvalid() {
        let te = build([turnError("auth_invalid")]).first { kindOf($0) == "turnError" }
        if case .turnError(_, let message) = te!.payload { XCTAssertTrue(message.range(of: "key", options: .caseInsensitive) != nil) }
    }
    func testTurnErrorRawFallback() {
        let te = build([turnError("HTTP 500: upstream boom")]).first { kindOf($0) == "turnError" }
        if case .turnError(_, let message) = te!.payload { XCTAssertEqual(message, "HTTP 500: upstream boom") }
    }
    func testNonErrorTurnNoErrorBlock() {
        XCTAssertFalse(build([agentEvent(50, ["type": "turn", "phase": "ended"])]).contains { kindOf($0) == "turnError" })
    }
}
