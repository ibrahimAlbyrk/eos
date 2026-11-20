//! The user's edits of routines' results before they went out, read from
//! 03's edits after a cursor (`mem_cursors` key `inbox-edits`), each a
//! moment to learn from. An edit's conversation is made from the edit
//! itself: the draft as the agent wrote it (read as outside text when it
//! was made from outside text) and a line saying what the user changed, in
//! the user's own words only where the draft came from outside.

use std::sync::Arc;

use eos_contracts::{EditOp, PartEdit};
use eos_core::inbox::{ResultEdit, ResultEdits};
use eos_core::store::{Store, StoredMoment};
use eos_core::{Clock, Error, Ids};
use eos_domain::EventRecord;
use eos_domain::experience::moments::Signal;
use serde_json::json;

use crate::settings;

/// Where the edits' cursor is kept.
pub const CURSOR: &str = "inbox-edits";
/// Edits read in one look.
const BATCH: usize = 100;
/// A part's text shown in an edit's line, at most.
const PART_CHARS: usize = 160;

/// The moment key of an edit.
pub fn edit_key(edit_id: i64) -> String {
    format!("edit:{edit_id}")
}

/// The edit an `edit:` moment key names.
pub fn edit_of(key: &str) -> Option<i64> {
    key.strip_prefix("edit:")?.parse().ok()
}

fn cut(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= PART_CHARS {
        return text;
    }
    let kept: String = text.chars().take(PART_CHARS).collect();
    format!("{kept}…")
}

fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// One line per part the user changed.
fn change(edit: &PartEdit, untrusted: bool) -> Option<String> {
    let role = edit.after.as_ref().or(edit.before.as_ref()).map_or("part", |p| p.role.as_str());
    match edit.op {
        EditOp::Changed => {
            let (before, after) = (edit.before.as_ref()?, edit.after.as_ref()?);
            let mut line = format!("rewrote the {role} as \"{}\"", cut(&after.text));
            let (was, is) = (words(&before.text), words(&after.text));
            if is * 10 < was * 8 {
                line.push_str(&format!(" (shortened from {was} to {is} words)"));
            }
            if !untrusted {
                line.push_str(&format!("; it was \"{}\"", cut(&before.text)));
            }
            Some(line)
        }
        EditOp::Removed if untrusted => Some(format!("removed a {role}")),
        EditOp::Removed => Some(format!("removed the {role} \"{}\"", cut(&edit.before.as_ref()?.text))),
        EditOp::Added => Some(format!("added a {role}: \"{}\"", cut(&edit.after.as_ref()?.text))),
        EditOp::Moved => None,
    }
}

/// What the user changed, in one message.
pub fn describe(edit: &ResultEdit) -> String {
    let lines: Vec<String> = edit.ops.iter().filter_map(|op| change(op, edit.derived_from_untrusted)).collect();
    format!("Before sending the {} draft, I {}.", edit.before.kind, lines.join("; "))
}

/// The edit as a conversation: the draft, then the user's change.
pub fn edit_rows(edit: &ResultEdit) -> Vec<EventRecord> {
    let draft: Vec<&str> = edit.before.parts.iter().map(|p| p.text.as_str()).collect();
    let row = |id: i64, kind: &str, payload: serde_json::Value| EventRecord {
        id,
        worker_id: edit_key(edit.id),
        ts: edit.at,
        kind: kind.to_owned(),
        payload: Some(payload.to_string()),
    };
    vec![
        row(
            edit.id - 2,
            "agent_event",
            json!({"type": "message", "role": "assistant", "blocks": [
            {"type": "tool_call", "callId": "draft", "name": "draft", "input": {"kind": edit.before.kind}}]}),
        ),
        row(
            edit.id - 1,
            "agent_event",
            json!({"type": "message", "role": "tool", "blocks": [
            {"type": "tool_result", "callId": "draft", "content": draft.join("\n\n")}]}),
        ),
        row(edit.id, "user_message", json!({"text": describe(edit)})),
    ]
}

/// Keeps a moment for each new edit with a change. Answers how many.
pub async fn capture(
    store: &Arc<dyn Store>,
    clock: &dyn Clock,
    ids: &dyn Ids,
    edits: &dyn ResultEdits,
) -> Result<usize, Error> {
    let mut kept = 0;
    loop {
        let cursor = store.read(|tx| tx.mem_cursors().get(CURSOR)).await?.unwrap_or(0);
        let batch = edits.list_since(cursor, BATCH).await?;
        let Some(last) = batch.last().map(|e| e.id) else { return Ok(kept) };
        let now = clock.now_ms();
        let moments: Vec<StoredMoment> = batch
            .iter()
            .filter(|e| e.ops.iter().any(|op| op.op != EditOp::Moved))
            .map(|e| StoredMoment {
                id: ids.moment_id(),
                worker_id: edit_key(e.id),
                source: "edit".into(),
                run_id: Some(e.run_id.clone()),
                signal: Signal::Edits.as_str().into(),
                trust: Signal::Edits.trust(),
                row_from: e.id,
                row_to: e.id,
                cues: "[]".into(),
                state: "pending".into(),
                note_id: None,
                attempts: 0,
                created_at: now,
                done_at: None,
            })
            .collect();
        kept += store
            .write(move |tx, _| {
                tx.mem_cursors().set(CURSOR, last, now)?;
                if !settings::read_in(tx)?.learning {
                    return Ok(0);
                }
                for moment in &moments {
                    tx.mem_moments().insert(moment)?;
                }
                Ok(moments.len())
            })
            .await?;
        if batch.len() < BATCH {
            return Ok(kept);
        }
    }
}
