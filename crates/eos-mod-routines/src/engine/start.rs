//! `RunStarter::start`: every check of a start, then its runs queued in one
//! write. The checks run inside that write, so two starts of one item cannot
//! both pass the same-item check.

use std::sync::Arc;

use eos_contracts::{
    Blueprint, Issues, ItemRef, OptionType, RoutineKind, RoutineOption, RoutineState, RunInput, TakesEmpty, Trigger,
    Validate,
};
use eos_core::routine::{NewRun, RunCreated, RunOrigin, StartError};
use eos_core::store::{MANUAL_SCOPE_HASH, ManualSignal, Outbox, StoredRun, StoredSignalSource, Tx};
use eos_core::{Alphabet, Error};
use eos_domain::routine::item;
use eos_domain::routine::run::RunState;
use serde_json::Value;

use super::{Engine, Queued, queue_run};
use crate::routes::{readable, showing_version};

/// A start takes at most this many items.
pub(crate) const ITEMS_MAX: usize = 20;
/// The same item again within a day asks first.
const REPEAT_MS: i64 = 24 * 60 * 60 * 1000;
/// How long a client request id answers its runs again.
const REQUEST_KEPT_MS: i64 = 10 * 60 * 1000;

/// The order runs leave the queue in: the user's own first, then agents' and
/// other routines', then triggers'.
pub(crate) fn priority(origin: &RunOrigin) -> i64 {
    match origin {
        RunOrigin::Hand | RunOrigin::Again { .. } | RunOrigin::Trial => 0,
        RunOrigin::Agent { .. } | RunOrigin::Routine { .. } => 1,
    }
}

pub(crate) async fn start(engine: &Arc<Engine>, new: NewRun) -> Result<Vec<RunCreated>, StartError> {
    let now = engine.clock.now_ms();
    if let Some(runs) = new.client_request_id.as_deref().and_then(|id| remembered(engine, id, now)) {
        return Ok(runs);
    }
    let (ids, device) = (engine.ids.clone(), engine.device.clone());
    let request = new.client_request_id.clone();
    let made = engine
        .store
        .write(move |tx, out| match queue(tx, out, &new, now, ids.as_ref(), &device) {
            // A store error may come after some runs were written: the job
            // must fail, so none of them is kept or announced.
            Err(StartError::Store(error)) => Err(error),
            refused_or_made => Ok(refused_or_made),
        })
        .await??;
    if let Some(id) = request {
        Engine::locked(&engine.requests).insert(id, (now, made.clone()));
    }
    tracing::info!(runs = made.len(), "runs queued");
    engine.wake.notify_one();
    Ok(made)
}

/// The runs a request made, when the same request came within ten minutes.
fn remembered(engine: &Engine, id: &str, now: i64) -> Option<Vec<RunCreated>> {
    let mut requests = Engine::locked(&engine.requests);
    requests.retain(|_, (at, _)| now - *at < REQUEST_KEPT_MS);
    requests.get(id).map(|(_, runs)| runs.clone())
}

/// The checks, then the writes. A refusal writes nothing.
fn queue(
    tx: &dyn Tx,
    out: &mut Outbox,
    new: &NewRun,
    now: i64,
    ids: &dyn eos_core::Ids,
    device: &str,
) -> Result<Vec<RunCreated>, StartError> {
    let routine =
        tx.routines().find(&new.routine_id)?.ok_or_else(|| StartError::UnknownRoutine(new.routine_id.clone()))?;
    if !takes_origin(routine.state, &new.origin) {
        return Err(StartError::RoutineState(routine.state));
    }
    let version = showing_version(tx, &routine.id)?;
    let blueprint = match &version {
        Some(version) => readable(version)?,
        None => None,
    };
    let blueprint = blueprint.ok_or_else(|| StartError::Invalid("routine: has no blueprint this app runs".into()))?;
    check_origin(tx, &routine.agents_may_start, &routine.id, &blueprint, &new.origin)?;
    let inputs = inputs(new, &blueprint)?;
    let keys: Vec<Option<String>> = inputs.iter().map(|input| input.item.as_ref().and_then(item::key)).collect();
    if !new.confirm_repeat {
        for key in keys.iter().flatten() {
            if let Some(earlier) = tx.runs().by_item(&routine.id, key)?.into_iter().find(|run| recent(run, now)) {
                return Err(StartError::SameItem { existing_run_id: earlier.id });
            }
        }
    }
    let kind = if new.origin == RunOrigin::Trial { "trial" } else { kind_word(routine.kind) };
    let version_id = version.map(|version| version.id).unwrap_or_default();
    let mut made = Vec::with_capacity(inputs.len());
    for (input, item_key) in inputs.into_iter().zip(keys) {
        let id = ids.run_id();
        queue_run(
            tx,
            out,
            Queued {
                id: id.clone(),
                routine_id: &routine.id,
                kind,
                origin: new.origin.word(),
                origin_ref: new.origin.reference().map(str::to_owned),
                door: new.door.clone(),
                input: &input,
                item_key: item_key.clone(),
                priority: priority(&new.origin),
                device,
                now,
            },
        )?;
        if matches!(new.origin, RunOrigin::Hand | RunOrigin::Again { .. }) {
            let manual = ManualSignal {
                source_id: manual_source(tx, ids, now)?,
                run_id: id.clone(),
                routine_id: routine.id.clone(),
                routine_version: version_id.clone(),
                subject: item_key.unwrap_or_else(|| format!("run:{id}")),
                version: input.item.as_ref().and_then(|item| item.version.clone()),
                item_json: serde_json::to_string(&input.item).map_err(|e| Error::storage(e.to_string()))?,
                at: now,
            };
            tx.signals().insert_manual(&manual)?;
        }
        made.push(RunCreated { id, state: RunState::Queued, not_before: input.at });
    }
    Ok(made)
}

/// Which starts a routine in this state takes (01 §4.8).
fn takes_origin(state: RoutineState, origin: &RunOrigin) -> bool {
    let by_hand = matches!(origin, RunOrigin::Hand | RunOrigin::Again { .. });
    match state {
        RoutineState::Active => true,
        RoutineState::Paused | RoutineState::Transient => by_hand,
        RoutineState::Draft => *origin == RunOrigin::Trial,
        RoutineState::Archived | RoutineState::Deleted => false,
    }
}

/// An agent starts a routine only when the routine lets it; another routine
/// only when this one's When names it.
fn check_origin(
    tx: &dyn Tx,
    agents_may_start: &bool,
    routine_id: &str,
    blueprint: &Blueprint,
    origin: &RunOrigin,
) -> Result<(), StartError> {
    match origin {
        RunOrigin::Agent { .. } if !agents_may_start => {
            Err(StartError::Invalid("origin: the routine does not let agents start it".into()))
        }
        RunOrigin::Routine { run_id } => {
            let upstream = tx.runs().find(run_id)?.map(|run| run.routine_id);
            let named = blueprint.when.on.iter().any(
                |trigger| matches!(trigger, Trigger::After { after, .. } if Some(&after.routine) == upstream.as_ref()),
            );
            if named && upstream.as_deref() != Some(routine_id) {
                Ok(())
            } else {
                Err(StartError::Invalid("origin: the routine's When does not name that routine".into()))
            }
        }
        _ => Ok(()),
    }
}

/// One input per run: the start's own, or one per item.
fn inputs(new: &NewRun, blueprint: &Blueprint) -> Result<Vec<RunInput>, StartError> {
    if new.items.len() > ITEMS_MAX {
        return Err(StartError::Invalid(format!("items: at most {ITEMS_MAX}")));
    }
    if new.items.len() > 1 && !blueprint.takes.many {
        return Err(StartError::Invalid("items: the routine takes one item at a time".into()));
    }
    let mut issues = Issues::default();
    new.input.validate(&mut issues);
    new.items.validate(&mut issues);
    if let Some(issue) = issues.into_vec().into_iter().next() {
        return Err(StartError::Invalid(issue.to_string()));
    }
    for (key, value) in &new.input.options {
        let option = blueprint.options.iter().find(|option| &option.key == key);
        let fits = option.is_some_and(|option| option_fits(option, value));
        if !fits {
            return Err(StartError::Invalid(format!("options.{key}: not a value the routine takes")));
        }
    }
    let inputs: Vec<RunInput> = if new.items.is_empty() {
        vec![new.input.clone()]
    } else {
        new.items.iter().map(|item: &ItemRef| RunInput { item: Some(item.clone()), ..new.input.clone() }).collect()
    };
    let without_item = |input: &RunInput| input.item.is_none() && input.items.as_ref().is_none_or(Vec::is_empty);
    if blueprint.takes.empty == TakesEmpty::Required && inputs.iter().any(without_item) {
        return Err(StartError::Invalid("item: Required".into()));
    }
    Ok(inputs)
}

fn option_fits(option: &RoutineOption, value: &Value) -> bool {
    match option.r#type {
        OptionType::Choice => value
            .as_str()
            .is_some_and(|value| option.values.as_ref().is_some_and(|values| values.iter().any(|v| v == value))),
        OptionType::Bool => value.is_boolean(),
        OptionType::Text => value.is_string(),
        OptionType::Number => value.is_number(),
    }
}

/// A run of the item that has not ended, or was made within a day.
fn recent(run: &StoredRun, now: i64) -> bool {
    !run.state.is_terminal() || now - run.created_at < REPEAT_MS
}

pub(crate) fn kind_word(kind: RoutineKind) -> &'static str {
    match kind {
        RoutineKind::Standing => "standing",
        RoutineKind::Project => "project",
        RoutineKind::Once => "once",
    }
}

/// The one source every run started by hand is a signal of, made the first
/// time one is.
fn manual_source(tx: &dyn Tx, ids: &dyn eos_core::Ids, now: i64) -> Result<String, Error> {
    if let Some(source) = tx.signal_sources().by_scope(MANUAL_SCOPE_HASH)? {
        return Ok(source.id);
    }
    let source = StoredSignalSource {
        id: ids.prefixed("src-", Alphabet::Hex, 12),
        kind: "manual".into(),
        source: None,
        scope_json: "{}".into(),
        scope_hash: MANUAL_SCOPE_HASH.into(),
        cursor_json: None,
        state: "active".into(),
        error_kind: None,
        failures: 0,
        interval_ms: 0,
        last_poll_at: None,
        next_poll_at: None,
        last_signal_at: None,
        catch_up_json: None,
        stopped_at: None,
        created_at: now,
        updated_at: now,
    };
    tx.signal_sources().insert(&source)?;
    Ok(source.id)
}
