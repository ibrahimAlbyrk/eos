//! Capture: a worker's conversation since the last look, read for the
//! moments memory learns from. Each look reads the rows after the worker's
//! cursor, finds the moments in them (`eos_domain::experience::moments`) and
//! writes the moments and the moved cursor in one write job, so a restart
//! neither loses nor repeats one. A moment holds row ranges and cues, never
//! text. A Code-view pane's conversation is read the same way from its
//! Claude Code transcript, under the cursor of its Claude session.

use std::sync::Arc;

use eos_contracts::ReactionActor;
use eos_core::routine::RunRef;
use eos_core::store::{Store, StoredMoment, Tx};
use eos_core::{Clock, Error, Ids};
use eos_domain::EventRecord;
use eos_domain::experience::moments::{Denial, MomentDraft, Reaction, Signal, scan_after};

use crate::settings;

/// The row kinds the moment rules read.
const KINDS: [&str; 8] = [
    "user_message",
    "agent_event",
    "state",
    "policy",
    "conversation_rewound",
    "message_recalled",
    "try_discarded",
    "try_kept",
];
/// Rows read in one look; a longer backlog is read by the next looks.
const ROWS: i64 = 2_000;
const DENIALS: i64 = 200;
const REACTIONS: i64 = 500;
/// What a run of these origins does teaches nothing: a trial or a replay is
/// the user trying the routine out (G32).
const UNTAUGHT_ORIGINS: [&str; 2] = ["trial", "replay"];

/// What one look found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Captured {
    /// Moments stored for reflection.
    pub stored: Vec<StoredMoment>,
    /// Quiet acceptances: credit for what was recalled, never a note.
    pub accepted: Vec<MomentDraft>,
    /// More rows wait after this look.
    pub more: bool,
}

pub struct Capture {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
}

impl std::fmt::Debug for Capture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capture").finish_non_exhaustive()
    }
}

fn denials_key(worker_id: &str) -> String {
    format!("deny:{worker_id}")
}

impl Capture {
    pub fn new(store: Arc<dyn Store>, clock: Arc<dyn Clock>, ids: Arc<dyn Ids>) -> Self {
        Self { store, clock, ids }
    }

    /// Reads the worker's rows since the last look. `run` is the run the
    /// worker belongs to, when it does. With Learning off, or for a run that
    /// teaches nothing, the cursor moves and nothing is kept.
    pub async fn look(&self, worker_id: &str, run: Option<RunRef>) -> Result<Captured, Error> {
        let now = self.clock.now_ms();
        let ids = self.ids.clone();
        let worker_id = worker_id.to_owned();
        let captured = self.store.write(move |tx, _| look_in(tx, ids.as_ref(), &worker_id, run.as_ref(), now)).await?;
        if !captured.stored.is_empty() {
            tracing::info!(moments = captured.stored.len(), "memory: captured");
        }
        Ok(captured)
    }

    /// Reads a Code-view conversation's rows (`rows`: its transcript as now
    /// read) after the last look.
    pub async fn look_code(&self, claude_session_id: &str, rows: Vec<EventRecord>) -> Result<Captured, Error> {
        let now = self.clock.now_ms();
        let ids = self.ids.clone();
        let key = code_key(claude_session_id);
        let captured = self.store.write(move |tx, _| look_code_in(tx, ids.as_ref(), &key, &rows, now)).await?;
        if !captured.stored.is_empty() {
            tracing::info!(moments = captured.stored.len(), "memory: captured from a Code-view pane");
        }
        Ok(captured)
    }
}

fn look_in(tx: &dyn Tx, ids: &dyn Ids, worker_id: &str, run: Option<&RunRef>, now: i64) -> Result<Captured, Error> {
    let cursor = tx.mem_cursors().get(worker_id)?.unwrap_or(0);
    let deny_key = denials_key(worker_id);
    let deny_cursor = tx.mem_cursors().get(&deny_key)?.unwrap_or(0);
    let rows = tx.events().scan(worker_id, &KINDS, cursor, ROWS)?;
    let denied = tx.pending().user_denials(worker_id, deny_cursor, DENIALS)?;
    let more = rows.len() as i64 == ROWS || denied.len() as i64 == DENIALS;
    if let Some(last) = rows.last() {
        tx.mem_cursors().set(worker_id, last.id, now)?;
    }
    if let Some(last) = denied.last() {
        tx.mem_cursors().set(&deny_key, last.row, now)?;
    }
    let taught = run.is_none_or(|r| r.kind != "trial" && !UNTAUGHT_ORIGINS.contains(&r.origin.as_str()));
    if !taught || !settings::read_in(tx)?.learning {
        return Ok(Captured { more, ..Captured::default() });
    }
    let reactions = match (rows.first(), rows.last()) {
        (Some(first), Some(last)) => tx
            .reactions()
            .list(worker_id, first.id, last.id, REACTIONS)?
            .into_iter()
            .filter(|r| r.actor == ReactionActor::User)
            .filter_map(|r| match r.emoji.as_deref() {
                Some("👍") => Some(Reaction { row: r.event_id, thumbs_up: true }),
                Some("👎") => Some(Reaction { row: r.event_id, thumbs_up: false }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let denials: Vec<Denial> = denied.into_iter().map(|d| Denial { row: d.row, tool: d.tool }).collect();
    let source = if run.is_some() { "run" } else { "agent" };
    // A look after an earlier one starts where that one stopped: on the agent's turn.
    keep(tx, ids, worker_id, source, run, scan_after(&rows, &denials, &reactions, cursor > 0), more, now)
}

/// Where a Code-view conversation's moments and cursor are kept: by its
/// Claude session, which outlives the pane that showed it.
pub fn code_key(claude_session_id: &str) -> String {
    format!("pty:{claude_session_id}")
}

/// A Code-view conversation's rows after its cursor (the transcript's rows
/// carry their position in the file as their id). Reactions, Try, edits and
/// the checker are not seen there.
fn look_code_in(tx: &dyn Tx, ids: &dyn Ids, key: &str, rows: &[EventRecord], now: i64) -> Result<Captured, Error> {
    let cursor = tx.mem_cursors().get(key)?.unwrap_or(0);
    let fresh: Vec<EventRecord> = rows.iter().filter(|r| r.id > cursor).cloned().collect();
    let Some(last) = fresh.last() else { return Ok(Captured::default()) };
    tx.mem_cursors().set(key, last.id, now)?;
    if !settings::read_in(tx)?.learning {
        return Ok(Captured::default());
    }
    keep(tx, ids, key, "code", None, scan_after(&fresh, &[], &[], cursor > 0), false, now)
}

#[allow(clippy::too_many_arguments)]
fn keep(
    tx: &dyn Tx,
    ids: &dyn Ids,
    worker_id: &str,
    source: &str,
    run: Option<&RunRef>,
    drafts: Vec<MomentDraft>,
    more: bool,
    now: i64,
) -> Result<Captured, Error> {
    let mut captured = Captured { more, ..Captured::default() };
    for draft in drafts {
        if draft.signal == Signal::Accepted {
            captured.accepted.push(draft);
            continue;
        }
        let moment = StoredMoment {
            id: ids.moment_id(),
            worker_id: worker_id.to_owned(),
            source: source.to_owned(),
            run_id: run.map(|r| r.run_id.clone()),
            signal: draft.signal.as_str().to_owned(),
            trust: draft.trust,
            row_from: draft.row_from,
            row_to: draft.row_to,
            cues: cues_json(&draft),
            state: "pending".to_owned(),
            note_id: None,
            attempts: 0,
            created_at: now,
            done_at: None,
        };
        tx.mem_moments().insert(&moment)?;
        captured.stored.push(moment);
    }
    Ok(captured)
}

fn cues_json(draft: &MomentDraft) -> String {
    serde_json::to_string(&draft.cues).unwrap_or_else(|_| "[]".to_owned())
}
