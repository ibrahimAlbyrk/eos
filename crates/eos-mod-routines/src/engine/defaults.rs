//! An option the user sets by hand again and again becomes its default
//! (01 G24): when the same value other than the default was chosen in
//! [`CHOSEN`] of the last [`STARTS`] starts by hand of the routine's head,
//! Eos keeps a new version with that default (author `eos`), whose note is
//! the routine page's one line with Undo (a restore of the version before).
//! Only starts made since the head was kept count, so an undo is not
//! learned again from the same starts. Several items started together are one start.

use eos_contracts::{RoutineState, VersionAuthor};
use eos_core::Error;
use eos_core::store::{Outbox, Tx};
use serde_json::Value;

use super::versions::{Added, Prepared, add_in};
use super::{Engine, live};
use crate::routes::readable;

/// Starts by hand looked at.
const STARTS: usize = 4;
/// Of them, how many chose the same value.
const CHOSEN: usize = 3;
/// Runs read to find those starts.
const RUNS_READ: i64 = 100;

/// Learns new defaults after a start by hand of `routine_id`, inside the
/// start's write.
pub(crate) fn learn_in(
    engine: &Engine,
    tx: &dyn Tx,
    out: &mut Outbox,
    routine_id: &str,
    now: i64,
) -> Result<(), Error> {
    let routine = live(tx, routine_id)?;
    if !matches!(routine.state, RoutineState::Active | RoutineState::Paused) {
        return Ok(());
    }
    let Some(head) = tx.routine_versions().head(routine_id)? else { return Ok(()) };
    let Some(mut blueprint) = readable(&head)? else { return Ok(()) };
    let starts = starts_since(tx, routine_id, head.created_at)?;
    let mut learned = Vec::new();
    for option in &mut blueprint.options {
        let chosen = starts.iter().map(|options| options.get(option.key.as_str()).unwrap_or(&option.default));
        let Some(value) = most_chosen(chosen, &option.default) else { continue };
        learned.push(format!("{} now defaults to {}", option.label, shown(&value)));
        option.default = value;
    }
    if learned.is_empty() {
        return Ok(());
    }
    let note = format!("{}: you chose it in {CHOSEN} of your last {STARTS} runs.", learned.join("; "));
    let prepared = Prepared { blueprint, trust: head.trust };
    let added = Added {
        routine_id,
        version_id: &engine.ids.routine_version_id(),
        author: VersionAuthor::Eos,
        note: Some(note),
        prepared: &prepared,
        device: &engine.device,
        now,
        patterns: &engine.patterns,
    };
    add_in(tx, out, added)?;
    tracing::info!(routine_id, options = learned.len(), "an option's default followed the user");
    Ok(())
}

/// The options object of each of the newest starts by hand made at or after
/// `since`.
fn starts_since(tx: &dyn Tx, routine_id: &str, since: i64) -> Result<Vec<Value>, Error> {
    let mut starts = Vec::new();
    let mut last_at = None;
    for run in tx.runs().by_routine(routine_id, RUNS_READ)? {
        if run.created_at < since {
            break;
        }
        if run.origin != "hand" || last_at == Some(run.created_at) {
            continue;
        }
        last_at = Some(run.created_at);
        let input: Value = serde_json::from_str(&run.input).unwrap_or_default();
        starts.push(input["options"].clone());
        if starts.len() == STARTS {
            break;
        }
    }
    Ok(starts)
}

/// The value other than `default` chosen at least [`CHOSEN`] times.
fn most_chosen<'a>(chosen: impl Iterator<Item = &'a Value>, default: &Value) -> Option<Value> {
    let mut counts: Vec<(&Value, usize)> = Vec::new();
    for value in chosen.filter(|value| *value != default) {
        match counts.iter_mut().find(|(seen, _)| *seen == value) {
            Some((_, n)) => *n += 1,
            None => counts.push((value, 1)),
        }
    }
    counts.into_iter().find(|(_, n)| *n >= CHOSEN).map(|(value, _)| value.clone())
}

fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "on".into(),
        Value::Bool(false) => "off".into(),
        other => other.to_string(),
    }
}
