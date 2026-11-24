//! The trial (01 G7, G45): a routine being made or changed is tried on real
//! past items before it starts. The items of its Takes source in the scope
//! its When reads, those its Which rules take on their facts, newest first;
//! one trial run for each of the newest three, or one dry run with no item
//! when there is none. Trial runs run exactly the version they were started
//! for, show their results and send nothing (03 G21).

use std::sync::Arc;

use eos_contracts::{
    Blueprint, CapabilityItem, DraftStatus, Fact, Facts, ItemRef, ResultMode, RoutineChangeReason, RunInput, Trigger,
};
use eos_core::Error;
use eos_core::capability::PastItemFilter;
use eos_core::routine::{NewRun, RunCreated, RunOrigin, StartError};
use eos_core::store::{StoredVersion, Tx};
use eos_domain::signals::which::{Verdict, evaluate};

use crate::engine::{Engine, announce_routine, start_runs};
use crate::routes::{item_ref, readable, showing_version};

/// A trial tries at most this many items.
pub(crate) const TRIAL_ITEMS: usize = 3;
/// How many past items are read to find those the Which rules take.
const PAST_READ: usize = 50;

/// The version a trial runs: the draft the architect works on, or the
/// version the routine shows.
pub(crate) fn version_in(tx: &dyn Tx, routine_id: &str) -> Result<Option<StoredVersion>, Error> {
    let draft = tx.routines().draft(routine_id)?.filter(|draft| draft.status != DraftStatus::Abandoned);
    if let Some(version_id) = draft.and_then(|draft| draft.draft_version_id) {
        return tx.routine_versions().find(routine_id, &version_id);
    }
    showing_version(tx, routine_id)
}

/// An item's facts as its capability gave them: the `facts` it carries, or
/// its data's own fields.
fn facts_of(item: &CapabilityItem) -> Facts {
    let fields = item.data.get("facts").filter(|facts| facts.is_object()).unwrap_or(&item.data);
    let Some(fields) = fields.as_object() else { return Facts::new() };
    fields
        .iter()
        .filter_map(|(name, value)| serde_json::from_value::<Fact>(value.clone()).ok().map(|fact| (name.clone(), fact)))
        .collect()
}

/// Real items `blueprint` would have taken, newest first, at most `limit`;
/// none when its Takes names no source.
pub(crate) async fn past_items(engine: &Engine, blueprint: &Blueprint, limit: usize) -> Result<Vec<ItemRef>, Error> {
    let Some(source) = &blueprint.takes.source else { return Ok(Vec::new()) };
    let scope = blueprint.when.on.iter().find_map(|trigger| match trigger {
        Trigger::Source { source: from, scope, .. } if from == source => Some(scope.clone()),
        _ => None,
    });
    let filter = PastItemFilter { scope: scope.unwrap_or_default(), query: None };
    let mut items = engine.reads.past_items(source, &filter, PAST_READ).await?;
    items.retain(|item| {
        blueprint.which.rule.as_ref().is_none_or(|rule| evaluate(rule, &facts_of(item)) == Verdict::Pass)
    });
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok(items.into_iter().take(limit).map(item_ref).collect())
}

/// Starts the trial of the routine's draft (or of the version it shows) and
/// marks its draft as trying.
pub(crate) async fn start(engine: &Arc<Engine>, routine_id: &str) -> Result<Vec<RunCreated>, StartError> {
    let id = routine_id.to_owned();
    let version = engine.store.read(move |tx| version_in(tx, &id)).await?;
    let version = version.ok_or_else(|| StartError::UnknownRoutine(routine_id.to_owned()))?;
    let blueprint = readable(&version)?.ok_or(StartError::NewerFormat)?;
    let items = past_items(engine, &blueprint, TRIAL_ITEMS).await?;
    let new = NewRun {
        routine_id: routine_id.to_owned(),
        version: Some(version.id.clone()),
        input: RunInput {
            item: None,
            items: None,
            trigger: None,
            options: Default::default(),
            note: None,
            result: ResultMode::ShowOnly,
            at: None,
            surface: None,
        },
        items,
        origin: RunOrigin::Trial,
        door: None,
        // A trial tries items the routine may have handled already.
        confirm_repeat: true,
        client_request_id: None,
    };
    let runs = start_runs(engine, new).await?;
    let (id, now) = (routine_id.to_owned(), engine.clock.now_ms());
    let patterns = engine.patterns.clone();
    engine
        .store
        .write(move |tx, out| {
            let Some(mut draft) = tx.routines().draft(&id)? else { return Ok(()) };
            if draft.draft_version_id.as_deref() != Some(version.id.as_str()) {
                return Ok(());
            }
            draft.status = DraftStatus::Trying;
            draft.updated_at = now;
            tx.routines().update_draft(&draft)?;
            announce_routine(tx, out, &id, RoutineChangeReason::Draft, now, &patterns)
        })
        .await?;
    tracing::info!(routine_id, runs = runs.len(), "a routine's trial started");
    Ok(runs)
}
