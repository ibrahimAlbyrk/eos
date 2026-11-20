//! A routine's finished runs as a source (02 §4.5 "after"): each routine
//! another one's When names by `after` has one source row whose cursor is
//! the sequence of the last finished run it kept. A pass keeps the runs
//! that finished since as signals, one each, and moves the cursor in the
//! same write; the router then decides them for every routine that waits
//! on that routine and that outcome. A signal is one link deeper in the
//! chain than the run that finished: past [`CHAIN_MAX`] it starts nothing.

use eos_contracts::{AfterOutcome, RunInput};
use eos_core::routine::{FinishedRun, RunIntake};
use eos_core::store::{NewSignal, Tx};
use eos_core::{Error, Ids};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::RunState;
use eos_domain::signals::key;

use crate::sources::{SourceSpec, source_in};

/// The kind of a finished-run source.
pub(crate) const AFTER: &str = "after";
/// The longest chain of routines one run may start; a deeper signal is
/// decided `refused`, reason `depth`.
pub(crate) const CHAIN_MAX: i64 = 3;
/// The finished runs one read takes.
const PAGE: i64 = 100;

/// A run that ended done and sent its result somewhere.
const DELIVERED: &str = "delivered";
const DONE: &str = "done";

/// The scope hash of the source of `upstream`'s finished runs.
pub(crate) fn scope_hash(upstream: &str) -> String {
    format!("{AFTER}:{upstream}")
}

/// Whether a run that ended as `kind` meets the outcome an `after` waits
/// for.
pub(crate) fn takes(outcome: AfterOutcome, kind: &str) -> bool {
    match outcome {
        AfterOutcome::Any => true,
        AfterOutcome::Done => kind == DONE || kind == DELIVERED,
        AfterOutcome::Delivered => kind == DELIVERED,
    }
}

/// How a run ended, as its signal's kind.
fn kind_of(run: &FinishedRun) -> &'static str {
    let sent = matches!(run.outcome, Some(Outcome::SentUnedited | Outcome::SentEdited | Outcome::AutoSent));
    match run.state {
        RunState::Done if sent => DELIVERED,
        state => state.as_str(),
    }
}

/// How deep in a chain the run is: the depth of the signal that started it.
fn depth_of(tx: &dyn Tx, run_id: &str) -> Result<i64, Error> {
    let Some(run) = tx.runs().find(run_id)? else { return Ok(0) };
    let input = serde_json::from_str::<RunInput>(&run.input).ok();
    let signal_id = input.and_then(|input| input.trigger).and_then(|trigger| trigger.signal_id.parse::<i64>().ok());
    let Some(signal_id) = signal_id else { return Ok(0) };
    Ok(tx.signals().find(signal_id)?.map_or(0, |signal| signal.signal.depth))
}

/// Keeps `upstream`'s runs that finished since the source's cursor as
/// signals, inside one write with the cursor; answers how many. A source
/// made now starts after the runs that finished before: they are not news.
pub(crate) fn follow_in(
    tx: &dyn Tx,
    intake: &dyn RunIntake,
    ids: &dyn Ids,
    upstream: &str,
    now: i64,
) -> Result<usize, Error> {
    let spec = SourceSpec {
        kind: AFTER,
        source: None,
        scope_json: serde_json::json!({ "routine": upstream }).to_string(),
        scope_hash: scope_hash(upstream),
        interval_ms: 0,
    };
    let (mut source, made) = source_in(tx, ids, spec, now)?;
    let mut cursor = source.cursor_json.as_deref().and_then(|json| json.parse::<i64>().ok()).unwrap_or(0);
    let mut kept = 0;
    loop {
        let finished = intake.finished_after(tx, upstream, cursor, PAGE)?;
        let Some(last) = finished.last() else { break };
        cursor = last.seq;
        if !made {
            for run in &finished {
                let key = key::after(upstream, &run.run_id);
                let kind = kind_of(run);
                let signal = NewSignal {
                    source_id: source.id.clone(),
                    key: key.clone(),
                    subject: key,
                    version: None,
                    kind: kind.to_owned(),
                    occurred_at: run.ended_at,
                    received_at: now,
                    facts_json: Some(serde_json::json!({ "outcome": kind }).to_string()),
                    item_json: "null".into(),
                    depth: depth_of(tx, &run.run_id)? + 1,
                };
                kept += usize::from(tx.signals().ingest(&signal)?.is_some());
            }
        }
        if (finished.len() as i64) < PAGE {
            break;
        }
    }
    if made || kept > 0 {
        source.cursor_json = Some(cursor.to_string());
        source.last_poll_at = Some(now);
        if kept > 0 {
            source.last_signal_at = Some(now);
        }
        source.updated_at = now;
        tx.signal_sources().update(&source)?;
    }
    if kept > 0 {
        tracing::info!(source_id = %source.id, signals = kept, "finished runs were kept");
    }
    Ok(kept)
}
