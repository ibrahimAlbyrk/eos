import Foundation

// Port of messageParser.js `normalizeEvents` (design §5.2): both event taxonomies → one block
// model, normalized ONCE at ingest. Legacy `WorkerEventType` rows pass through by type; the
// canonical `type:agent_event` row expands to jsonl/tool_running/tool_done/hook/exit while
// preserving `blockId`, so the renderer sees a single stream of ~16 block kinds.
public enum MessageNormalizer {
    public static func normalize(_ events: [JSONValue], workerId: String) -> [Block] {
        events.compactMap { normalizeOne($0, workerId: workerId) }
    }

    private static func normalizeOne(_ ev: JSONValue, workerId: String) -> Block? {
        let id = ev["id"]?.stringValue ?? ev["id"]?.intValue.map(String.init) ?? UUID().uuidString
        let ts = ev["ts"]?.doubleValue ?? ev["created_at"]?.doubleValue ?? 0
        let blockId = ev["blockId"]?.stringValue ?? ev["block_id"]?.stringValue
        let type = ev["type"]?.stringValue ?? ev["kind"]?.stringValue ?? ""

        // Canonical agent_event → expand on its inner `event`/`subtype`.
        if type == "agent_event" {
            let sub = ev["event"]?.stringValue ?? ev["subtype"]?.stringValue ?? ev["payload"]?["type"]?.stringValue ?? ""
            return Block(id: id, workerId: workerId, blockId: blockId,
                         kind: agentEventKind(sub), ts: ts,
                         text: ev["text"]?.stringValue ?? ev["payload"]?["text"]?.stringValue, raw: ev)
        }

        // Legacy WorkerEventType pass-through.
        return Block(id: id, workerId: workerId, blockId: blockId,
                     kind: legacyKind(type), ts: ts,
                     text: ev["text"]?.stringValue ?? ev["message"]?.stringValue, raw: ev)
    }

    private static func agentEventKind(_ sub: String) -> Block.Kind {
        switch sub {
        case "jsonl": return .jsonl
        case "tool_running": return .tool
        case "tool_done": return .tool
        case "hook": return .hook
        case "exit": return .exit
        default: return .assistant
        }
    }

    private static func legacyKind(_ type: String) -> Block.Kind {
        switch type {
        case "user", "user_message": return .user
        case "assistant", "assistant_message": return .assistant
        case "thinking", "reasoning": return .thinking
        case "tool", "tool_use": return .tool
        case "tool_group": return .toolGroup
        case "agent_run": return .agentRun
        case "report": return .report
        case "directive": return .directive
        case "peer_request", "peer-request": return .peerRequest
        case "loop": return .loop
        case "terminal": return .terminal
        case "delivery_failed", "deliveryFailed": return .deliveryFailed
        case "cleared": return .cleared
        case "push": return .push
        case "pull": return .pull
        case "worktree_preserved", "worktreePreserved": return .worktreePreserved
        default: return .unknown
        }
    }
}
