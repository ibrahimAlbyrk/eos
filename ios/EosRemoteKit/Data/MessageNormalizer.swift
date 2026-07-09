import Foundation

// The event→block parser (spec 03 §4, faithful port of app/ui/src/lib/messageParser.js).
//
// Staged pipeline over one worker's durable event rows:
//   applyClears → applyRewinds → applyRecalls   (§4.3, display-only history edits)
//   → buildBlocks                                (§4.4, == normalizeEvents ∘ decode)
//        normalizeEvents  : agent_event → legacy content shapes (§4.4)
//        deriveToolLifecycle : running/done/closed (§4.6, ToolLifecycle.swift)
//        agent-span attribution : subagent inner-tool folding (§4.5)
//        decode loop + lane grouping (flushTools/pushTool) (§4.4)
//        attachAskUserAnswers (§4.8)
//   → sortBlocksByTs                             (§4.9, stable creation-domain sort)
//
// Live overlays (§4.10) are a render-time second pass — NOT here (Phase 4b, plugs into AppModel).
public enum MessageNormalizer {

    // The full pipeline for one worker's rows. `bootPromptOffset` = 1 when an orchestrator-spawned
    // worker's boot prompt has no event (see applyRewinds).
    public static func buildBlocks(_ rows: [JSONValue], workerId: String = "", bootPromptOffset: Int = 0) -> [Block] {
        buildBlocks(evs: rows.map(toEv), workerId: workerId, bootPromptOffset: bootPromptOffset)
    }

    // Same pipeline over ALREADY-PARSED event rows. The JSON-string decode in `toEv` dominates
    // buildBlocks (measured ~51ms of ~51ms for a 2000-row transcript); the caller (DeviceConnection)
    // caches one `Ev` per durable row at ingest so a live burst never re-decodes the whole window.
    // Parsing this way is behavior-identical: `toEv` is a pure row→Ev map, so pre-mapping is the same
    // input to the same staged pipeline.
    public static func buildBlocks(evs: [Ev], workerId: String = "", bootPromptOffset: Int = 0) -> [Block] {
        let cleared = applyClears(evs)
        let rewound = applyRewinds(cleared, bootPromptOffset: bootPromptOffset)
        let recalled = applyRecalls(rewound)
        let blocks = decode(recalled, workerId: workerId)
        return sortBlocksByTs(blocks)
    }

    // Convenience for the AppModel call site: build + return in creation-domain order.
    public static func normalize(_ rows: [JSONValue], workerId: String) -> [Block] {
        buildBlocks(rows, workerId: workerId)
    }
}

// A raw event row → Ev { type, ts, payload }. Durable rows carry ts and a JSON-string payload.
// Public so the transcript pipeline can parse a row ONCE at ingest and cache the result (the JSON
// string decode here is the buildBlocks hotspot).
public func toEv(_ row: JSONValue) -> Ev {
    let type = row["type"]?.stringValue ?? row["kind"]?.stringValue ?? ""
    let ts = row["ts"]?.doubleValue ?? row["created_at"]?.doubleValue ?? 0
    // The row-id is needed by applyRecalls; stash it on the payload object so decode can read it.
    var payload = parsePayload(row["payload"])
    if let idNum = row["id"]?.intValue, case .object(var o) = payload {
        o["__rowId"] = .number(Double(idNum)); payload = .object(o)
    }
    return Ev(type: type, ts: ts, payload: payload)
}

// MARK: - §4.3 display-history edits

// conversation_cleared (/clear): drop everything before the last marker; the marker survives and
// renders as a divider.
func applyClears(_ events: [Ev]) -> [Ev] {
    for i in stride(from: events.count - 1, through: 0, by: -1) where events[i].type == "conversation_cleared" {
        return Array(events[i...])
    }
    return events
}

private func normRewindText(_ s: String?) -> String {
    (s ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

// conversation_rewound (double-Esc rewind): cut the abandoned branch from the rewound-to user
// message up to the marker. Match by rewound text (either-way prefix) then by payload.index.
func applyRewinds(_ events: [Ev], bootPromptOffset: Int = 0) -> [Ev] {
    var out: [Ev] = []
    for ev in events {
        if ev.type != "conversation_rewound" { out.append(ev); continue }
        let cut = findRewindCut(out, ev.payload, bootPromptOffset)
        if cut >= 0 { out = Array(out[0..<cut]) }
    }
    return out
}

private func findRewindCut(_ events: [Ev], _ payload: JSONValue, _ bootPromptOffset: Int) -> Int {
    let needles = [payload["text"]?.stringValue, payload["display"]?.stringValue]
        .map(normRewindText).filter { !$0.isEmpty }
    for i in stride(from: events.count - 1, through: 0, by: -1) {
        let e = events[i]
        guard e.type == "user_message" || e.type == "orchestrator_message" else { continue }
        let t = normRewindText(parsePayload(e.payload)["text"]?.stringValue)
        if t.isEmpty { continue }
        if needles.contains(where: { $0 == t || $0.hasPrefix(t) || t.hasPrefix($0) }) { return i }
    }
    if let index = payload["index"]?.intValue {
        var count = bootPromptOffset
        for i in 0..<events.count {
            let e = events[i]
            guard e.type == "user_message" || e.type == "orchestrator_message" else { continue }
            if count == index { return i }
            count += 1
        }
    }
    return -1
}

// message_recalled (interrupt-before-response, SDK lane): drop the user_message matched by the
// recalled row id (fallback clientMsgId); the marker itself renders nothing.
func applyRecalls(_ events: [Ev]) -> [Ev] {
    var rowIds: Set<Int> = []
    var clientMsgIds: Set<String> = []
    for ev in events where ev.type == "message_recalled" {
        let p = parsePayload(ev.payload)
        if let rid = p["recalledRowId"]?.intValue { rowIds.insert(rid) }
        if let cid = p["clientMsgId"]?.stringValue { clientMsgIds.insert(cid) }
    }
    if rowIds.isEmpty && clientMsgIds.isEmpty { return events }
    return events.filter { ev in
        if ev.type == "message_recalled" { return false }
        if ev.type != "user_message" { return true }
        if let rid = ev.payload["__rowId"]?.intValue, rowIds.contains(rid) { return false }
        let ids = parsePayload(ev.payload)["clientMsgIds"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        return !ids.contains { clientMsgIds.contains($0) }
    }
}

// MARK: - §4.9 sort

// Stable sort by creation-domain ts ascending (Swift sort is not stable, so decorate with the
// original index and break ties on it — mirrors Array.prototype.sort stability).
public func sortBlocksByTs(_ blocks: [Block]) -> [Block] {
    blocks.enumerated().sorted { a, b in
        if a.element.ts != b.element.ts { return a.element.ts < b.element.ts }
        return a.offset < b.offset
    }.map(\.element)
}

// MARK: - §4.4 normalizeEvents

private func isSubagentToolUse(_ p: JSONValue) -> Bool {
    p["spawnsSubagent"]?.boolValue == true || p["name"]?.stringValue == "Agent"
}

// Expand agent_event rows into the legacy content shapes buildBlocks understands (jsonl +
// tool_running/tool_done + turn/exit barriers) so one decoder handles both lanes. Non-agent_event
// rows pass through untouched.
func normalizeEvents(_ events: [Ev]) -> [Ev] {
    var out: [Ev] = []
    func jsonl(_ ts: Double, _ obj: [String: JSONValue]) { out.append(Ev(type: "jsonl", ts: ts, payload: .object(obj))) }

    for ev in events {
        if ev.type != "agent_event" { out.append(ev); continue }
        let e = parsePayload(ev.payload)
        let ts = ev.ts
        let etype = e["type"]?.stringValue
        let role = e["role"]?.stringValue

        if etype == "message" && role == "assistant" {
            for b in e["blocks"]?.arrayValue ?? [] {
                switch b["type"]?.stringValue {
                case "text":
                    jsonl(ts, ["kind": .string("assistant_text"), "text": .string(b["text"]?.stringValue ?? ""),
                               "blockId": b["blockId"] ?? .null])
                case "reasoning":
                    jsonl(ts, ["kind": .string("thinking"), "text": .string(b["text"]?.stringValue ?? ""),
                               "blockId": b["blockId"] ?? .null])
                case "tool_call":
                    var o: [String: JSONValue] = ["kind": .string("tool_use"), "id": b["callId"] ?? .null,
                                                  "name": .string(b["name"]?.stringValue ?? ""),
                                                  "input": b["input"] ?? .object([:])]
                    if b["spawnsSubagent"]?.boolValue == true { o["spawnsSubagent"] = .bool(true) }
                    jsonl(ts, o)
                case "tool_result":
                    jsonl(ts, ["kind": .string("tool_result"), "toolUseId": b["callId"] ?? .null,
                               "isError": .bool(b["isError"]?.boolValue == true),
                               "text": .string(b["content"]?.stringValue ?? ""), "patch": b["patch"] ?? .null])
                case "skill":
                    jsonl(ts, ["kind": .string("skill_body"), "toolUseId": b["callId"] ?? .null,
                               "text": .string(b["text"]?.stringValue ?? "")])
                default: break
                }
            }
        } else if etype == "message" && role == "tool" {
            for b in e["blocks"]?.arrayValue ?? [] where b["type"]?.stringValue == "tool_result" {
                jsonl(ts, ["kind": .string("tool_result"), "toolUseId": b["callId"] ?? .null,
                           "isError": .bool(b["isError"]?.boolValue == true),
                           "text": .string(b["content"]?.stringValue ?? ""), "patch": b["patch"] ?? .null])
            }
        } else if etype == "activity" {
            let kind = e["kind"]?.stringValue
            if kind == "tool_started" {
                var o: [String: JSONValue] = ["toolName": e["toolName"] ?? .null, "toolUseId": e["callId"] ?? .null,
                                              "input": e["input"] ?? .object([:])]
                if let parent = e["parentCallId"], parent != .null { o["parentAgentToolUseId"] = parent }
                out.append(Ev(type: "tool_running", ts: ts, payload: .object(o)))
            } else if kind == "tool_finished" {
                out.append(Ev(type: "tool_done", ts: ts, payload: .object([
                    "toolName": e["toolName"] ?? .null, "toolUseId": e["callId"] ?? .null,
                    "result": .string(e["result"]?.stringValue ?? ""), "isError": .bool(e["isError"]?.boolValue == true)])))
            }
            // alive → drop
        } else if etype == "turn" && e["phase"]?.stringValue != "started" {
            out.append(Ev(type: "hook", ts: ts, payload: .object(["event": .string("Stop")])))
            if e["phase"]?.stringValue == "error" {
                out.append(Ev(type: "turn_error", ts: ts, payload: .object(["reason": .string(e["reason"]?.stringValue ?? "")])))
            }
        } else if etype == "session" && e["phase"]?.stringValue == "ended" {
            out.append(Ev(type: "exit", ts: ts, payload: .object([:])))
        } else if etype == "subagent_started" || etype == "subagent_completed" {
            out.append(Ev(type: etype!, ts: ts, payload: e))
        }
    }
    return out
}

// MARK: - §4.4/§4.5 decode

// An intermediate mutable block (mirrors the JS plain-object out[] before it becomes a typed Block).
private enum RawBlock {
    case user(text: String, ts: Double)
    case assistant(text: String, ts: Double, blockId: String?)
    case thinking(text: String, ts: Double, blockId: String?)
    case tool(Tool)
    case toolGroup(lane: Block.Lane, summary: String, tools: [Tool], ts: Double)
    case agentRun(AgentRun, ts: Double)
    case report(text: String, fromWorker: String?, workerName: String?, ts: Double)
    case directive(text: String, fromParent: String?, parentName: String?, ts: Double)
    case peerRequest(text: String, fromWorker: String?, fromName: String?, ts: Double)
    case loop(text: String, ts: Double)
    case loopCheck(LoopCheck, ts: Double)
    case terminal(Terminal, ts: Double)
    case deliveryFailed(text: String, ts: Double)
    case cleared(ts: Double)
    case turnError(reason: String, message: String, ts: Double)
    case gitPush(ok: Bool, message: String, branch: String?, ts: Double)
    case gitPull(ok: Bool, message: String, branch: String?, ts: Double)
    case worktreePreserved(path: String, branch: String, diffStat: String, ts: Double)
}

func decode(_ rawEvents: [Ev], workerId: String) -> [Block] {
    let events = normalizeEvents(rawEvents)
    let lc = deriveToolLifecycle(events)

    // --- agent span discovery (§4.5) ---
    var toolUseIds: Set<String> = []
    var agentSpans: [String: (startTs: Double, endTs: Double, background: Bool)] = [:]
    var subagentStartCallIds: Set<String> = []
    var callIdByAgentId: [String: String] = [:]
    var subagentCompletions: [(p: JSONValue, ts: Double)] = []
    var skillBodyById: [String: ParsedSkillBody] = [:]

    for ev in events {
        if ev.type == "subagent_started" {
            let p = parsePayload(ev.payload)
            if let callId = p["callId"]?.stringValue {
                subagentStartCallIds.insert(callId)
                if let agentId = p["agentId"]?.stringValue { callIdByAgentId[agentId] = callId }
            }
            continue
        }
        if ev.type == "subagent_completed" { subagentCompletions.append((parsePayload(ev.payload), ev.ts)); continue }
        if ev.type != "jsonl" { continue }
        let p = parsePayload(ev.payload)
        if p["kind"]?.stringValue == "tool_use", let id = p["id"]?.stringValue {
            toolUseIds.insert(id)
            if isSubagentToolUse(p) { agentSpans[id] = (startTs: ev.ts, endTs: .infinity, background: false) }
        } else if p["kind"]?.stringValue == "skill_body", let id = p["toolUseId"]?.stringValue {
            skillBodyById[id] = parseSkillBody(p["text"]?.stringValue)
        }
    }
    for callId in subagentStartCallIds where agentSpans[callId] != nil { agentSpans[callId]!.background = true }

    var completionByCallId: [String: (status: String, result: String?)] = [:]
    for (p, ts) in subagentCompletions {
        let callId = p["callId"]?.stringValue ?? p["agentId"]?.stringValue.flatMap { callIdByAgentId[$0] }
        guard let callId else { continue }
        completionByCallId[callId] = (status: p["status"]?.stringValue ?? "completed",
                                      result: p["result"] == .null ? nil : p["result"]?.stringValue)
        if agentSpans[callId] != nil { agentSpans[callId]!.endTs = ts }
    }
    for ev in events where ev.type == "jsonl" {
        let p = parsePayload(ev.payload)
        if p["kind"]?.stringValue == "tool_result", let id = p["toolUseId"]?.stringValue, agentSpans[id] != nil {
            if agentSpans[id]!.background == false { agentSpans[id]!.endTs = ev.ts }
        }
    }

    // --- inner-tool attribution (§4.5) ---
    var agentToolMap: [String: [Tool]] = [:]
    func attachInnerTool(_ agentId: String, _ tr: JSONValue, _ evIdx: Int, _ ts: Double) {
        let turnExempt = agentSpans[agentId]?.background == true
        let id = tr["toolUseId"]?.stringValue ?? ""
        let name = tr["toolName"]?.stringValue ?? "unknown"
        agentToolMap[agentId, default: []].append(Tool(
            id: id, name: name, verb: verbFor(name), input: tr["input"] ?? .object([:]),
            result: lc.resultOf(id), running: !lc.isClosed(id, evIdx, turnExempt: turnExempt),
            done: lc.isDone(id), ts: ts))
    }
    for i in 0..<events.count {
        let ev = events[i]
        guard ev.type == "tool_running" else { continue }
        let tr = parsePayload(ev.payload)
        guard let tid = tr["toolUseId"]?.stringValue, !toolUseIds.contains(tid) else { continue }
        if let parent = tr["parentAgentToolUseId"]?.stringValue, agentSpans[parent] != nil {
            attachInnerTool(parent, tr, i, ev.ts); continue
        }
        var bestAgent: String? = nil
        var bestDist = Double.infinity
        for (agentId, span) in agentSpans {
            if ev.ts >= span.startTs && ev.ts <= span.endTs { bestAgent = agentId; break }
            if span.background && ev.ts > span.endTs { continue }
            if ev.ts > span.startTs && (ev.ts - span.startTs) < bestDist {
                bestDist = ev.ts - span.startTs; bestAgent = agentId
            }
        }
        if let bestAgent { attachInnerTool(bestAgent, tr, i, ev.ts) }
    }
    // Iterating a dictionary is unordered; the JS relies on insertion order only for the timestamp
    // fallback tie-break (exact containment wins first, and is order-independent). Sort each agent's
    // tools by ts to keep deterministic order.
    var attributedToolIds: Set<String> = []
    for (agentId, tools) in agentToolMap {
        agentToolMap[agentId] = tools.sorted { $0.ts < $1.ts }
        for t in tools { attributedToolIds.insert(t.id) }
    }

    // --- main decode loop (§4.4) ---
    // The mutable decode state lives in a reference-type Decoder so flushTools/pushTool can call each
    // other without tripping Swift's exclusive-access enforcement (a nested closure mutating captured
    // vars while calling another such closure is a fatal access conflict).
    let decoder = Decoder(lc: lc, toolUseIds: toolUseIds, attributedToolIds: attributedToolIds,
                          agentSpans: agentSpans, subagentStartCallIds: subagentStartCallIds,
                          completionByCallId: completionByCallId, agentToolMap: agentToolMap, skillBodyById: skillBodyById)
    for evIdx in 0..<events.count { decoder.step(events[evIdx], evIdx) }
    decoder.flushTools()

    return attachAskUserAnswers(decoder.out).map { rawToBlock($0, workerId: workerId) }
}

// The main decode loop as a reference type (see the call site for why). Holds the running block list
// and the pending-tool lane state; step() dispatches one normalized event; flushTools/pushTool do the
// lane grouping (§4.4).
private final class Decoder {
    private(set) var out: [RawBlock] = []
    private var lastAsstIdx: Int? = nil          // last pushed assistant block (text coalescing)
    private var pendingTools: [Tool] = []
    private var pendingLane: Block.Lane? = nil
    private var lastPeerReq: AgentRef? = nil
    private var lastAskPeerIdx: Int? = nil       // index in pendingTools of the ask_peer awaiting a consult

    private let lc: ToolLifecycle
    private let toolUseIds: Set<String>
    private let attributedToolIds: Set<String>
    private let agentSpans: [String: (startTs: Double, endTs: Double, background: Bool)]
    private let subagentStartCallIds: Set<String>
    private let completionByCallId: [String: (status: String, result: String?)]
    private let agentToolMap: [String: [Tool]]
    private let skillBodyById: [String: ParsedSkillBody]

    init(lc: ToolLifecycle, toolUseIds: Set<String>, attributedToolIds: Set<String>,
         agentSpans: [String: (startTs: Double, endTs: Double, background: Bool)],
         subagentStartCallIds: Set<String>, completionByCallId: [String: (status: String, result: String?)],
         agentToolMap: [String: [Tool]], skillBodyById: [String: ParsedSkillBody]) {
        self.lc = lc; self.toolUseIds = toolUseIds; self.attributedToolIds = attributedToolIds
        self.agentSpans = agentSpans; self.subagentStartCallIds = subagentStartCallIds
        self.completionByCallId = completionByCallId; self.agentToolMap = agentToolMap; self.skillBodyById = skillBodyById
    }

    func flushTools() {
        guard !pendingTools.isEmpty else { return }
        if pendingTools.count == 1 {
            out.append(.tool(pendingTools[0]))
        } else {
            out.append(.toolGroup(lane: pendingLane!, summary: summarizeLane(pendingLane!, pendingTools),
                                   tools: pendingTools, ts: pendingTools[0].ts))
        }
        pendingTools = []; pendingLane = nil; lastAskPeerIdx = nil
    }

    private func pushTool(_ tool: Tool) {
        var tool = tool
        if tool.name == "mcp__worker__respond_to_peer", tool.peerTo == nil, let req = lastPeerReq { tool.peerTo = req }
        let lane = laneOf(tool.name)
        if lane == nil {
            flushTools()
            out.append(.tool(tool))
            return
        }
        if !pendingTools.isEmpty && lane != pendingLane { flushTools() }
        pendingLane = lane
        pendingTools.append(tool)
        if tool.name == "mcp__worker__ask_peer" { lastAskPeerIdx = pendingTools.count - 1 }
    }

    func step(_ ev: Ev, _ evIdx: Int) {
        let p = parsePayload(ev.payload)
        let anchor = p["anchorTs"]?.doubleValue ?? p["sentAt"]?.doubleValue ?? ev.ts

        switch ev.type {
        case "user_message":
            flushTools(); lastAsstIdx = nil
            out.append(.user(text: p["text"]?.stringValue ?? "", ts: anchor))
        case "worker_report":
            flushTools(); lastAsstIdx = nil
            out.append(.report(text: p["text"]?.stringValue ?? "",
                               fromWorker: p["fromWorker"]?.stringValue, workerName: p["workerName"]?.stringValue, ts: anchor))
        case "orchestrator_message":
            flushTools(); lastAsstIdx = nil
            out.append(.directive(text: p["text"]?.stringValue ?? "",
                                  fromParent: p["fromParent"]?.stringValue, parentName: p["parentName"]?.stringValue, ts: anchor))
        case "loop_continuation":
            flushTools(); lastAsstIdx = nil
            out.append(.loop(text: p["text"]?.stringValue ?? "", ts: anchor))
        case "loop_check":
            flushTools(); lastAsstIdx = nil
            out.append(.loopCheck(LoopCheck(attempt: p["attempt"]?.intValue, maxAttempts: p["maxAttempts"]?.intValue,
                                            strategy: p["strategy"]?.stringValue, met: p["met"]?.boolValue ?? false,
                                            outcome: p["outcome"]?.stringValue, reason: p["reason"]?.stringValue ?? ""), ts: ev.ts))
        case "peer_request":
            flushTools(); lastAsstIdx = nil
            lastPeerReq = AgentRef(id: p["fromWorker"]?.stringValue, name: p["fromName"]?.stringValue)
            out.append(.peerRequest(text: p["text"]?.stringValue ?? "",
                                    fromWorker: p["fromWorker"]?.stringValue, fromName: p["fromName"]?.stringValue, ts: anchor))
        case "peer_consult":
            if let idx = lastAskPeerIdx, idx < pendingTools.count, pendingTools[idx].peerTo == nil {
                let input = pendingTools[idx].input
                let matchById = input["peerId"]?.stringValue == p["toWorker"]?.stringValue
                let matchByName = p["toName"]?.stringValue != nil && input["peerName"]?.stringValue == p["toName"]?.stringValue
                if matchById || matchByName {
                    pendingTools[idx].peerTo = AgentRef(id: p["toWorker"]?.stringValue, name: p["toName"]?.stringValue)
                }
            }
        case "tool_running":
            if let tid = p["toolUseId"]?.stringValue, !toolUseIds.contains(tid), !attributedToolIds.contains(tid) {
                lastAsstIdx = nil
                let name = p["toolName"]?.stringValue ?? "unknown"
                pushTool(Tool(id: tid, name: name, verb: verbFor(name), input: p["input"] ?? .object([:]),
                              result: lc.resultOf(tid), running: !lc.isClosed(tid, evIdx), done: lc.isDone(tid), ts: ev.ts))
            }
        case "lifecycle":
            if p["phase"]?.stringValue == "delivery_failed" {
                flushTools(); lastAsstIdx = nil
                out.append(.deliveryFailed(text: p["text"]?.stringValue ?? "", ts: ev.ts))
            }
        case "turn_error":
            flushTools(); lastAsstIdx = nil
            let reason = p["reason"]?.stringValue ?? ""
            out.append(.turnError(reason: reason, message: providerErrorMessage(reason), ts: ev.ts))
        case "conversation_cleared":
            flushTools(); lastAsstIdx = nil
            out.append(.cleared(ts: ev.ts))
        case "terminal":
            flushTools(); lastAsstIdx = nil
            out.append(.terminal(Terminal(runId: p["runId"]?.stringValue, command: p["command"]?.stringValue ?? "",
                                          output: p["output"]?.stringValue ?? "", exitCode: p["exitCode"]?.intValue ?? 0,
                                          note: p["note"]?.stringValue, truncated: p["truncated"]?.boolValue ?? false, done: true), ts: ev.ts))
        case "git_push":
            flushTools(); lastAsstIdx = nil
            out.append(.gitPush(ok: p["ok"]?.boolValue ?? false, message: p["message"]?.stringValue ?? "",
                                branch: p["branch"]?.stringValue, ts: ev.ts))
        case "git_pull":
            flushTools(); lastAsstIdx = nil
            out.append(.gitPull(ok: p["ok"]?.boolValue ?? false, message: p["message"]?.stringValue ?? "",
                                branch: p["branch"]?.stringValue, ts: ev.ts))
        case "worktree":
            if p["phase"]?.stringValue == "preserved" {
                flushTools(); lastAsstIdx = nil
                out.append(.worktreePreserved(path: p["path"]?.stringValue ?? "", branch: p["branch"]?.stringValue ?? "",
                                              diffStat: p["diffStat"]?.stringValue ?? "", ts: ev.ts))
            }
        case "jsonl":
            decodeJsonl(p, ev.ts, evIdx: evIdx)
        default:
            break
        }
    }

    // The jsonl branch — assistant_text coalescing, empty-thinking skip, tool_use split (agentRun
    // folding vs pushTool).
    private func decodeJsonl(_ p: JSONValue, _ ts: Double, evIdx: Int) {
        let kind = p["kind"]?.stringValue
        let tsTranscript = p["tsTranscript"]?.doubleValue ?? ts
        let blockId = p["blockId"] == .null ? nil : p["blockId"]?.stringValue

        if kind == "assistant_text" {
            flushTools()
            if let idx = lastAsstIdx, idx == out.count - 1, case .assistant(let text, let ats, let bid) = out[idx] {
                out[idx] = .assistant(text: text + "\n" + (p["text"]?.stringValue ?? ""), ts: ats, blockId: bid)
            } else {
                out.append(.assistant(text: p["text"]?.stringValue ?? "", ts: tsTranscript, blockId: blockId))
                lastAsstIdx = out.count - 1
            }
        } else if kind == "thinking" {
            let text = p["text"]?.stringValue ?? ""
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return } // signature-only
            flushTools(); lastAsstIdx = nil
            out.append(.thinking(text: text, ts: tsTranscript, blockId: blockId))
        } else if kind == "tool_use" {
            lastAsstIdx = nil
            let id = p["id"]?.stringValue ?? ""
            if isSubagentToolUse(p) {
                flushTools()
                let isBackground = subagentStartCallIds.contains(id)
                let completion = isBackground ? completionByCallId[id] : nil
                let cleanResult: String? = isBackground ? (completion?.result) : lc.resultOf(id)?.text
                let tools = agentToolMap[id] ?? []
                let closed = isBackground ? (completion != nil || lc.exitAfter(evIdx)) : lc.isClosed(id, evIdx)
                let input = p["input"] ?? .object([:])
                let desc = input["description"]?.stringValue
                    ?? { let s = input["prompt"]?.stringValue ?? ""; return s.isEmpty ? nil : String(s.prefix(100)) }()
                    ?? "agent"
                out.append(.agentRun(AgentRun(
                    toolUseId: id, description: desc, prompt: input["prompt"]?.stringValue ?? "",
                    model: input["model"]?.stringValue ?? p["parentModel"]?.stringValue,
                    subagentType: input["subagent_type"]?.stringValue,
                    status: closed ? (completion?.status ?? "completed") : "running",
                    background: isBackground, result: cleanResult, tools: tools), ts: tsTranscript))
            } else {
                let name = p["name"]?.stringValue ?? ""
                let skill = skillBodyById[id]
                pushTool(Tool(id: id, name: name, verb: verbFor(name), input: p["input"] ?? .object([:]),
                              result: lc.resultOf(id), running: !lc.isClosed(id, evIdx), done: lc.isDone(id),
                              ts: tsTranscript, skillBody: skill?.body, skillPath: skill?.path))
            }
        }
    }
}

// MARK: - §4.8 attachAskUserAnswers

// For each AskUserQuestion tool, look ahead ≤3 blocks for a user block starting "My answers…"; fold
// it into the tool result and remove that user bubble.
private func attachAskUserAnswers(_ blocks: [RawBlock]) -> [RawBlock] {
    var out = blocks
    var removeIndices: Set<Int> = []
    for i in 0..<out.count {
        guard case .tool(var tool) = out[i], tool.name == "AskUserQuestion" else { continue }
        var j = i + 1
        while j < out.count && j <= i + 3 {
            if case .user(let text, _) = out[j], text.hasPrefix("My answers to your questions:") {
                tool.result = ToolResult(text: text, isError: false)
                tool.running = false; tool.done = true
                out[i] = .tool(tool)
                removeIndices.insert(j)
                break
            }
            j += 1
        }
    }
    if removeIndices.isEmpty { return out }
    return out.enumerated().filter { !removeIndices.contains($0.offset) }.map(\.element)
}

// MARK: - RawBlock → Block

// The stable render key (spec 03 §4.9): tool/group/agentRun/terminal key on their inner id; others on
// blockId or ts.
private func rawToBlock(_ raw: RawBlock, workerId: String) -> Block {
    func key(_ kind: String, _ ts: Double, _ blockId: String?) -> String {
        if let blockId { return "\(kind)-\(blockId)" }
        return "\(kind)-\(fmt(ts))"
    }
    switch raw {
    case .user(let text, let ts):
        return Block(id: key("user", ts, nil), workerId: workerId, ts: ts, payload: .user(text: text, optimistic: false))
    case .assistant(let text, let ts, let bid):
        return Block(id: key("assistant", ts, bid), workerId: workerId, blockId: bid, ts: ts, payload: .assistant(text: text))
    case .thinking(let text, let ts, let bid):
        return Block(id: key("thinking", ts, bid), workerId: workerId, blockId: bid, ts: ts, payload: .thinking(text: text))
    case .tool(let tool):
        return Block(id: "t-\(tool.id.isEmpty ? fmt(tool.ts) : tool.id)", workerId: workerId, ts: tool.ts, payload: .tool(tool))
    case .toolGroup(let lane, let summary, let tools, let ts):
        let first = tools.first?.id
        return Block(id: "tg-\(first.map { $0.isEmpty ? fmt(ts) : $0 } ?? fmt(ts))", workerId: workerId, ts: ts,
                     payload: .toolGroup(lane: lane, summary: summary, tools: tools))
    case .agentRun(let run, let ts):
        return Block(id: "ag-\(run.toolUseId.isEmpty ? fmt(ts) : run.toolUseId)", workerId: workerId, ts: ts, payload: .agentRun(run))
    case .report(let text, let fw, let wn, let ts):
        return Block(id: key("report", ts, nil), workerId: workerId, ts: ts, payload: .report(text: text, fromWorker: fw, workerName: wn))
    case .directive(let text, let fp, let pn, let ts):
        return Block(id: key("directive", ts, nil), workerId: workerId, ts: ts, payload: .directive(text: text, fromParent: fp, parentName: pn))
    case .peerRequest(let text, let fw, let fn, let ts):
        return Block(id: key("peerRequest", ts, nil), workerId: workerId, ts: ts, payload: .peerRequest(text: text, fromWorker: fw, fromName: fn))
    case .loop(let text, let ts):
        return Block(id: key("loop", ts, nil), workerId: workerId, ts: ts, payload: .loop(text: text))
    case .loopCheck(let check, let ts):
        return Block(id: key("loopCheck", ts, nil), workerId: workerId, ts: ts, payload: .loopCheck(check))
    case .terminal(let term, let ts):
        return Block(id: "term-\(term.runId.map { $0.isEmpty ? fmt(ts) : $0 } ?? fmt(ts))", workerId: workerId, ts: ts, payload: .terminal(term))
    case .deliveryFailed(let text, let ts):
        return Block(id: key("deliveryFailed", ts, nil), workerId: workerId, ts: ts, payload: .deliveryFailed(text: text))
    case .cleared(let ts):
        return Block(id: key("cleared", ts, nil), workerId: workerId, ts: ts, payload: .cleared)
    case .turnError(let reason, let message, let ts):
        return Block(id: key("turnError", ts, nil), workerId: workerId, ts: ts, payload: .turnError(reason: reason, message: message))
    case .gitPush(let ok, let message, let branch, let ts):
        return Block(id: key("push", ts, nil), workerId: workerId, ts: ts, payload: .gitPush(ok: ok, message: message, branch: branch))
    case .gitPull(let ok, let message, let branch, let ts):
        return Block(id: key("pull", ts, nil), workerId: workerId, ts: ts, payload: .gitPull(ok: ok, message: message, branch: branch))
    case .worktreePreserved(let path, let branch, let diffStat, let ts):
        return Block(id: key("worktreePreserved", ts, nil), workerId: workerId, ts: ts,
                     payload: .worktreePreserved(path: path, branch: branch, diffStat: diffStat))
    }
}

// A compact ts string for a render key (avoids "100.0" style formatting that would desync keys).
private func fmt(_ ts: Double) -> String {
    ts == ts.rounded() ? String(Int(ts)) : String(ts)
}
