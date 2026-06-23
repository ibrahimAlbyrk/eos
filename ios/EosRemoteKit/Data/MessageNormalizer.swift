import Foundation

// Port of messageParser.js `normalizeEvents` (design §5.2): both event taxonomies → one block
// model, normalized ONCE at ingest. A durable row is { id, worker_id, ts, type, payload } where
// `payload` is a JSON STRING (the DB column). The claude-sdk lane logs `agent_event` rows whose
// payload is the canonical AgentEvent (contracts/canonical.ts): a `message` carries an ordered
// `blocks[]` of text/reasoning/tool_call. The claude-cli lane logs legacy `jsonl` rows. One row
// can expand into several display blocks (reasoning + text + tool calls), so we return [Block].
// Non-conversational rows (state/heartbeat/usage/lifecycle/hook/…) are dropped to keep the
// transcript readable — the renderer sees only the ~handful of conversational kinds.
public enum MessageNormalizer {
    public static func normalize(_ rows: [JSONValue], workerId: String) -> [Block] {
        rows.flatMap { normalizeRow($0, workerId: workerId) }
    }

    private static func normalizeRow(_ ev: JSONValue, workerId: String) -> [Block] {
        let rowId = ev["id"]?.intValue.map(String.init) ?? ev["id"]?.stringValue ?? UUID().uuidString
        let ts = ev["ts"]?.doubleValue ?? ev["created_at"]?.doubleValue ?? 0
        let type = ev["type"]?.stringValue ?? ev["kind"]?.stringValue ?? ""
        let p = payloadObject(ev["payload"])

        switch type {
        case "user_message", "orchestrator_message":
            return text(p, "text").map {
                [block(rowId, workerId, nil, .user, ts, $0)]
            } ?? []
        case "loop_continuation":
            return [block(rowId, workerId, nil, .directive, ts, text(p, "text") ?? "Dynamic loop")]
        case "worker_report":
            return [block(rowId, workerId, nil, .report, ts,
                          text(p, "headline") ?? text(p, "text") ?? "Report")]
        case "peer_request", "peer_consult":
            return [block(rowId, workerId, nil, .peerRequest, ts, text(p, "text") ?? "Peer request")]
        case "exit":
            return [block(rowId, workerId, nil, .exit, ts, text(p, "reason") ?? "Exited")]
        case "tool_running", "tool_done":
            return [block(rowId, workerId, nil, .tool, ts, text(p, "toolName") ?? "Tool")]
        case "jsonl":
            return normalizeJsonl(p, rowId, workerId, ts)
        case "agent_event":
            return normalizeAgentEvent(p, rowId, workerId, ts)
        default:
            return []   // state, heartbeat, usage, lifecycle, hook, policy, permission_*, terminal, …
        }
    }

    // Legacy claude-cli jsonl rows: a single discriminated payload.
    private static func normalizeJsonl(_ p: JSONValue?, _ rowId: String, _ workerId: String, _ ts: Double) -> [Block] {
        switch p?["kind"]?.stringValue {
        case "assistant_text": return text(p, "text").map { [block(rowId, workerId, nil, .assistant, ts, $0)] } ?? []
        case "thinking":       return text(p, "text").map { [block(rowId, workerId, nil, .thinking, ts, $0)] } ?? []
        case "tool_use":       return [block(rowId, workerId, nil, .tool, ts, text(p, "name") ?? "Tool")]
        default:               return []   // tool_result: folded into its tool card on web; skip here
        }
    }

    // Canonical agent_event: only `message` events carry transcript content. Each content block
    // becomes its own display block, keeping array order via a zero-padded index suffix so the
    // (ts, id) sort preserves reasoning → text → tool order within the row. `blockId` is carried
    // so a live streaming buffer (agent:delta) can be dropped when its durable block lands.
    private static func normalizeAgentEvent(_ p: JSONValue?, _ rowId: String, _ workerId: String, _ ts: Double) -> [Block] {
        guard p?["type"]?.stringValue == "message" else { return [] }
        let role = p?["role"]?.stringValue ?? "assistant"
        let blocks = p?["blocks"]?.arrayValue ?? []
        var out: [Block] = []
        for (i, cb) in blocks.enumerated() {
            let id = "\(rowId)#\(String(format: "%03d", i))"
            let blockId = cb["blockId"]?.stringValue
            switch cb["type"]?.stringValue {
            case "text":
                if let t = text(cb, "text") { out.append(block(id, workerId, blockId, role == "user" ? .user : .assistant, ts, t)) }
            case "reasoning":
                if let t = text(cb, "text") { out.append(block(id, workerId, blockId, .thinking, ts, t)) }
            case "tool_call":
                out.append(block(id, workerId, nil, .tool, ts, cb["name"]?.stringValue ?? "Tool"))
            case "skill":
                out.append(block(id, workerId, nil, .tool, ts, "Skill"))
            default:
                break   // tool_result folds into its tool card; ignore standalone here
            }
        }
        return out
    }

    // payload is a JSON string on durable rows, an object on live frames — accept either.
    private static func payloadObject(_ v: JSONValue?) -> JSONValue? {
        guard let v else { return nil }
        if case .string(let s) = v { return JSONValue.parse(s) }
        return v
    }

    // Non-empty text or nil (so empty bubbles are dropped).
    private static func text(_ p: JSONValue?, _ key: String) -> String? {
        guard let s = p?[key]?.stringValue, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }

    private static func block(_ id: String, _ workerId: String, _ blockId: String?,
                              _ kind: Block.Kind, _ ts: Double, _ text: String) -> Block {
        Block(id: id, workerId: workerId, blockId: blockId, kind: kind, ts: ts, text: text, raw: .null)
    }
}
