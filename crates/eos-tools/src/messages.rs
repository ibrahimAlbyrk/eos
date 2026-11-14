//! A worker's event log as the conversation it holds: the messages only,
//! whoever wrote them. The log is dense with rows that are no message (tool
//! calls, usage, state), so a caller reads more rows than it wants messages.

use eos_contracts::{AgentEvent, AgentMessageEventRole, ContentBlock};
use eos_domain::EventRecord;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Message {
    pub(crate) ts: i64,
    pub(crate) role: &'static str,
    pub(crate) text: String,
}

/// JavaScript's `trim` leaves nothing: the text says nothing.
fn blank(text: &str) -> bool {
    text.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

fn message(ts: i64, role: &'static str, text: Option<&str>) -> Option<Message> {
    let text = text.filter(|text| !blank(text))?;
    Some(Message { ts, role, text: text.to_owned() })
}

/// An agent event is a message only when the assistant said something:
/// its text blocks joined, reasoning and tool calls left out.
fn assistant(ts: i64, payload: &Value) -> Option<Message> {
    let event: AgentEvent = eos_contracts::parse(payload).ok()?;
    let AgentEvent::Message(said) = event else { return None };
    if said.role != AgentMessageEventRole::Assistant {
        return None;
    }
    let texts: Vec<&str> = said
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) if !blank(&text.text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect();
    message(ts, "assistant", Some(&texts.join("\n")))
}

fn normalize(row: &EventRecord) -> Option<Message> {
    let payload: Value = serde_json::from_str(row.payload.as_deref()?).ok()?;
    if !payload.is_object() && !payload.is_array() {
        return None;
    }
    let text = payload.get("text").and_then(Value::as_str);
    match row.kind.as_str() {
        "agent_event" => assistant(row.ts, &payload),
        // Rows of the old terminal lane: only the assistant's text is a message.
        "jsonl" if payload.get("kind").and_then(Value::as_str) == Some("assistant_text") => {
            message(row.ts, "assistant", text)
        }
        "user_message" => message(row.ts, "user", text),
        "orchestrator_message" => message(row.ts, "orchestrator", text),
        "worker_report" => message(row.ts, "worker", text),
        "peer_request" => message(row.ts, "peer", text),
        _ => None,
    }
}

/// The newest `n` messages among `rows` (oldest first), oldest first.
pub(crate) fn newest_messages(rows: &[EventRecord], n: usize) -> Vec<Message> {
    let mut messages: Vec<Message> = rows.iter().filter_map(normalize).collect();
    if messages.len() > n {
        messages.drain(..messages.len() - n);
    }
    messages
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(kind: &str, payload: Value, ts: i64) -> EventRecord {
        EventRecord { id: ts, worker_id: "w-1".into(), ts, kind: kind.into(), payload: Some(payload.to_string()) }
    }

    fn said(blocks: Value) -> Value {
        json!({"type": "message", "role": "assistant", "blocks": blocks})
    }

    #[test]
    fn an_assistant_message_is_its_text_blocks_joined() {
        let blocks = json!([
            {"type": "text", "text": "first"},
            {"type": "reasoning", "text": "hidden thinking"},
            {"type": "text", "text": "second"},
        ]);
        let rows = [row("agent_event", said(blocks), 100)];
        assert_eq!(newest_messages(&rows, 5), [Message { ts: 100, role: "assistant", text: "first\nsecond".into() }]);
        let cli = [row("jsonl", json!({"kind": "assistant_text", "text": "cli reply"}), 200)];
        assert_eq!(newest_messages(&cli, 5), [Message { ts: 200, role: "assistant", text: "cli reply".into() }]);
    }

    #[test]
    fn every_inbound_message_has_its_role() {
        let rows = [
            row("user_message", json!({"text": "hello"}), 1),
            row("orchestrator_message", json!({"text": "do X", "fromParent": "o-1", "parentName": "Orch"}), 2),
            row("worker_report", json!({"text": "result: done", "fromWorker": "w-2", "workerName": "child"}), 3),
            row("peer_request", json!({"text": "any tips?", "fromWorker": "p-9"}), 4),
        ];
        let roles: Vec<&str> = newest_messages(&rows, 5).iter().map(|m| m.role).collect();
        assert_eq!(roles, ["user", "orchestrator", "worker", "peer"]);
    }

    #[test]
    fn rows_that_are_no_message_are_skipped() {
        let rows = [
            row("jsonl", json!({"kind": "thinking", "text": "hmm"}), 1),
            row("jsonl", json!({"kind": "tool_use", "name": "Bash", "input": {}}), 2),
            row("jsonl", json!({"kind": "tool_result", "isError": false, "text": "ok"}), 3),
            row("jsonl", json!({"kind": "user_text", "text": "duplicate user turn"}), 4),
            row("jsonl", json!({"kind": "skill_body", "toolUseId": "t1", "text": "SKILL.md body"}), 5),
            row("agent_event", said(json!([{"type": "tool_call", "callId": "c1", "name": "Bash", "input": {}}])), 6),
            row("agent_event", said(json!([{"type": "reasoning", "text": "just thinking"}])), 7),
            row(
                "agent_event",
                json!({"type": "message", "role": "tool", "blocks": [{"type": "tool_result", "callId": "c1", "content": "done"}]}),
                8,
            ),
            row("agent_event", json!({"type": "turn", "phase": "ended"}), 9),
            row("usage", json!({"in": 10, "out": 20}), 10),
            row("user_message", json!({"text": "   "}), 11),
            EventRecord { id: 12, worker_id: "w-1".into(), ts: 12, kind: "user_message".into(), payload: None },
            EventRecord {
                id: 13,
                worker_id: "w-1".into(),
                ts: 13,
                kind: "user_message".into(),
                payload: Some("{bad".into()),
            },
        ];
        assert_eq!(newest_messages(&rows, 5), []);
    }

    #[test]
    fn the_newest_n_messages_come_back_oldest_first() {
        let rows = [
            row("user_message", json!({"text": "m1"}), 1),
            row("agent_event", said(json!([{"type": "text", "text": "m2"}])), 2),
            row("tool_running", json!({"toolName": "Bash", "toolUseId": null, "input": {}}), 3),
            row("user_message", json!({"text": "m3"}), 4),
            row("jsonl", json!({"kind": "assistant_text", "text": "m4"}), 5),
        ];
        let texts: Vec<String> = newest_messages(&rows, 2).into_iter().map(|m| m.text).collect();
        assert_eq!(texts, ["m3", "m4"]);
        assert_eq!(newest_messages(&rows, 50).len(), 4);
    }
}
