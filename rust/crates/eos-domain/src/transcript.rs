//! Lists that cover a whole conversation. The transcript itself is read in
//! pages; these pick, from every stored row, the few a panel needs
//! (`manager/routes/prompt-events.ts`, `subagent-events.ts`, `attachments.ts`).

use std::collections::HashSet;

use eos_contracts::{ChatAttachment, WorkerEventType, parse_attachment_message};
use serde_json::Value;

use crate::event::EventRecord;

mod facts;

/// The prompts of a conversation and the markers that hide some of them
/// (clear, rewind, recall): what the turn index is rebuilt from.
pub const PROMPT_EVENT_TYPES: [WorkerEventType; 5] = [
    WorkerEventType::UserMessage,
    WorkerEventType::OrchestratorMessage,
    WorkerEventType::ConversationCleared,
    WorkerEventType::ConversationRewound,
    WorkerEventType::MessageRecalled,
];

const PROMPT_KINDS: [&str; 5] =
    ["user_message", "orchestrator_message", "conversation_cleared", "conversation_rewound", "message_recalled"];

/// One tool call a row is about. `parent` is the subagent call an inner tool
/// runs under; `name` is set on the row that starts the call.
#[derive(Debug, Default)]
struct CallRef {
    id: Option<String>,
    parent: Option<String>,
    name: Option<String>,
    launches_subagent: bool,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn is(value: &Value, key: &str, want: &str) -> bool {
    value.get(key).and_then(Value::as_str) == Some(want)
}

/// Rows are canonical `agent_event` rows or the older `jsonl` /
/// `tool_running` / `tool_done` shapes; tool calls are read out of either.
fn call_refs(kind: &str, p: &Value) -> Vec<CallRef> {
    match kind {
        "agent_event" if is(p, "type", "message") => p
            .get("blocks")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| {
                        if is(b, "type", "tool_call") {
                            let launches =
                                b.get("spawnsSubagent") == Some(&Value::Bool(true)) || is(b, "name", "Agent");
                            Some(CallRef {
                                id: text(b, "callId"),
                                name: text(b, "name"),
                                launches_subagent: launches,
                                ..CallRef::default()
                            })
                        } else if is(b, "type", "tool_result") {
                            Some(CallRef { id: text(b, "callId"), ..CallRef::default() })
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default(),
        "agent_event" if is(p, "type", "activity") => {
            let started = is(p, "kind", "tool_started");
            let parent = text(p, "parentCallId");
            let launches = started && is(p, "toolName", "Agent") && parent.is_none();
            let name = if started { text(p, "toolName") } else { None };
            vec![CallRef { id: text(p, "callId"), parent, name, launches_subagent: launches }]
        }
        "jsonl" if is(p, "kind", "tool_use") => {
            let launches = p.get("spawnsSubagent") == Some(&Value::Bool(true)) || is(p, "name", "Agent");
            vec![CallRef {
                id: text(p, "id"),
                name: text(p, "name"),
                launches_subagent: launches,
                ..CallRef::default()
            }]
        }
        "jsonl" if is(p, "kind", "tool_result") => vec![CallRef { id: text(p, "toolUseId"), ..CallRef::default() }],
        "tool_running" | "tool_done" => {
            let started = kind == "tool_running";
            let parent = text(p, "parentAgentToolUseId");
            let launches = started && is(p, "toolName", "Agent") && parent.is_none();
            let name = if started { text(p, "toolName") } else { None };
            vec![CallRef { id: text(p, "toolUseId"), parent, name, launches_subagent: launches }]
        }
        _ => Vec::new(),
    }
}

/// A row that closes the tools still open, as the dashboard's tool lifecycle
/// sees it (`app/ui/src/lib/toolLifecycle.js`): keep the two in step.
fn is_barrier(kind: &str, p: &Value) -> bool {
    match kind {
        "exit" => true,
        "hook" => is(p, "event", "Stop") || is(p, "event", "SessionEnd"),
        "state" => ["IDLE", "ENDING", "DONE"].iter().any(|s| is(p, "state", s)),
        "lifecycle" => ["interrupted", "delivery_failed", "pty_exit"].iter().any(|s| is(p, "phase", s)),
        "agent_event" => {
            (is(p, "type", "turn") && !is(p, "phase", "started"))
                || (is(p, "type", "session") && is(p, "phase", "ended"))
        }
        _ => false,
    }
}

fn is_subagent_lifecycle(kind: &str, p: &Value) -> bool {
    kind == "agent_event"
        && ["subagent_started", "subagent_completed", "subagent_profile"].iter().any(|t| is(p, "type", t))
}

/// The only kinds of row the subagent selection can keep or learn from: the
/// prompts, the agent's own events, the turn barriers and the older tool rows.
/// A log is read for it skipping the rest (permission decisions, spawns, …).
pub const SUBAGENT_ROW_KINDS: [&str; 13] = [
    "user_message",
    "orchestrator_message",
    "conversation_cleared",
    "conversation_rewound",
    "message_recalled",
    "agent_event",
    "exit",
    "hook",
    "state",
    "lifecycle",
    "jsonl",
    "tool_running",
    "tool_done",
];

/// What the subagent selection needs of one row, read from its payload once:
/// a whole log can then be judged a slice at a time, without holding it.
#[derive(Debug)]
pub struct SubagentRowMeta {
    pub id: i64,
    pub ts: i64,
    refs: Vec<CallRef>,
    /// A prompt row, a subagent's lifecycle or a turn barrier: always sent.
    always: bool,
    /// The call a `subagent_started` row names.
    started: Option<String>,
}

impl SubagentRowMeta {
    pub fn of(row: &EventRecord) -> Self {
        let p = row.payload.as_deref().map_or(Value::Null, facts::facts);
        let started = (row.kind == "agent_event" && is(&p, "type", "subagent_started"))
            .then(|| p.get("callId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned))
            .flatten();
        Self {
            id: row.id,
            ts: row.ts,
            refs: call_refs(&row.kind, &p),
            always: PROMPT_KINDS.contains(&row.kind.as_str())
                || is_subagent_lifecycle(&row.kind, &p)
                || is_barrier(&row.kind, &p),
            started,
        }
    }
}

/// Every row needed to rebuild each subagent of the whole conversation — its
/// launch, inner tools, result and lifecycle — and each Artifact call with its
/// result, plus the prompt rows and the turn barriers: their ids, in the
/// conversation's order (time, then id), whatever order `rows` came in.
pub fn select_subagent_ids(rows: &[SubagentRowMeta]) -> Vec<i64> {
    let mut agents: HashSet<&str> =
        rows.iter().flat_map(|r| &r.refs).filter(|r| r.launches_subagent).filter_map(|r| r.id.as_deref()).collect();
    // A run started by some other call (a message that resumed a stopped subagent).
    agents.extend(rows.iter().filter_map(|r| r.started.as_deref()));
    let mut wanted = agents.clone();
    for r in rows.iter().flat_map(|r| &r.refs) {
        let under_agent = r.parent.as_deref().is_some_and(|parent| agents.contains(parent));
        if under_agent || r.name.as_deref() == Some("Artifact") {
            wanted.extend(r.id.as_deref());
        }
    }
    let mut kept: Vec<(i64, i64)> = rows
        .iter()
        .filter(|row| {
            row.always
                || row.refs.iter().any(|r| {
                    r.id.as_deref().is_some_and(|id| wanted.contains(id))
                        || r.parent.as_deref().is_some_and(|parent| wanted.contains(parent))
                })
        })
        .map(|row| (row.ts, row.id))
        .collect();
    kept.sort_unstable();
    kept.into_iter().map(|(_, id)| id).collect()
}

/// [`select_subagent_ids`] over rows in hand: the rows it keeps, in their order.
pub fn select_subagent_rows(rows: Vec<EventRecord>) -> Vec<EventRecord> {
    let metas: Vec<SubagentRowMeta> = rows.iter().map(SubagentRowMeta::of).collect();
    let keep: HashSet<i64> = select_subagent_ids(&metas).into_iter().collect();
    rows.into_iter().filter(|row| keep.contains(&row.id)).collect()
}

/// Every file attached anywhere in a conversation, from its `user_message`
/// rows (oldest first). A path counts once: its first sighting wins.
pub fn attachments_of(user_messages: &[EventRecord]) -> Vec<ChatAttachment> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in user_messages {
        // The attachment list is a suffix of the payload's `text`; a row that
        // is not JSON or has no text simply has none.
        let text = row
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .and_then(|p| p.get("text").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        for a in parse_attachment_message(&text).attachments {
            if seen.insert(a.path.clone()) {
                out.push(ChatAttachment {
                    label: a.label,
                    kind: a.kind,
                    path: a.path,
                    message_id: row.id.into(),
                    ts: row.ts.into(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, kind: &str, payload: &str) -> EventRecord {
        EventRecord { id, worker_id: "w".into(), ts: id * 10, kind: kind.into(), payload: Some(payload.into()) }
    }

    // manager/routes/__tests__/subagent-events.test.ts
    #[test]
    fn a_subagents_rows_are_kept_and_unrelated_tools_dropped() {
        let rows = vec![
            row(1, "user_message", r#"{"text":"go"}"#),
            row(
                2,
                "agent_event",
                r#"{"type":"message","blocks":[{"type":"tool_call","callId":"read-1","name":"Read"}]}"#,
            ),
            row(
                3,
                "agent_event",
                r#"{"type":"message","blocks":[{"type":"tool_call","callId":"task-1","name":"Task","spawnsSubagent":true}]}"#,
            ),
            row(4, "agent_event", r#"{"type":"subagent_started","callId":"task-1","agentId":"a1"}"#),
            row(
                5,
                "agent_event",
                r#"{"type":"message","blocks":[{"type":"tool_call","callId":"grep-1","name":"Grep","parentCallId":"task-1"}]}"#,
            ),
            row(
                6,
                "agent_event",
                r#"{"type":"activity","kind":"tool_started","callId":"grep-1","parentCallId":"task-1","toolName":"Grep"}"#,
            ),
            row(7, "agent_event", r#"{"type":"message","blocks":[{"type":"tool_result","callId":"grep-1"}]}"#),
            row(8, "agent_event", r#"{"type":"message","blocks":[{"type":"tool_result","callId":"read-1"}]}"#),
            row(
                9,
                "agent_event",
                r#"{"type":"message","blocks":[{"type":"tool_call","callId":"art-1","name":"Artifact"}]}"#,
            ),
            row(10, "agent_event", r#"{"type":"message","blocks":[{"type":"tool_result","callId":"art-1"}]}"#),
            row(11, "agent_event", r#"{"type":"subagent_completed","callId":"task-1","agentId":"a1"}"#),
            row(12, "agent_event", r#"{"type":"message","blocks":[{"type":"text","text":"done"}]}"#),
            row(13, "agent_event", r#"{"type":"turn","phase":"ended"}"#),
            row(14, "state", r#"{"state":"WORKING"}"#),
            row(15, "state", r#"{"state":"IDLE"}"#),
            row(16, "tool_running", r#"{"toolUseId":"old-1","toolName":"Agent"}"#),
            row(17, "tool_done", r#"{"toolUseId":"old-2","parentAgentToolUseId":"old-1"}"#),
            row(18, "jsonl", r#"{"kind":"tool_use","id":"j-1","name":"Bash"}"#),
            row(19, "exit", "not json"),
        ];
        let kept: Vec<i64> = select_subagent_rows(rows).into_iter().map(|r| r.id).collect();
        // The inner tool (5, 7) is known to run under the subagent's call by its activity row (6).
        assert_eq!(kept, [1, 3, 4, 5, 6, 7, 9, 10, 11, 13, 15, 16, 17, 19]);
    }

    // manager/routes/__tests__/attachments.test.ts
    #[test]
    fn attachments_are_listed_once_with_their_first_message() {
        let rows = vec![
            row(
                3,
                "user_message",
                r#"{"text":"Look.\n\nattachments:\n- [notes.md] (file): /work/notes.md\n- [shot.png] (image): /work/shot.png"}"#,
            ),
            row(9, "user_message", r#"{"text":"Again.\n\nattachments:\n- [notes.md] (file): /work/notes.md"}"#),
            row(12, "user_message", "broken"),
            row(15, "user_message", r#"{"other":1}"#),
        ];
        let found = attachments_of(&rows);
        let brief: Vec<(&str, i64)> = found.iter().map(|a| (a.path.as_str(), a.message_id.0 as i64)).collect();
        assert_eq!(brief, [("/work/notes.md", 3), ("/work/shot.png", 3)]);
        assert_eq!(found[0].ts.0 as i64, 30);
    }
}
