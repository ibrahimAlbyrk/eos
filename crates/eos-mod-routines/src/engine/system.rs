//! Built-in routines (01 G49). A project milestone that names a system step
//! (`system: "forge.test"`) is run by the feature that owns the step
//! ([`SystemSteps`]) instead of the lead; its result then goes through the
//! check and the gate as a lead's does. The lead meanwhile waits and is not
//! reminded. A built-in routine itself (origin `builtin`) is made and kept
//! by its feature ([`BuiltinRoutines`]): hidden from the user's lists and
//! never theirs to change.

use std::sync::Arc;

use eos_contracts::{RoutineKind, RoutineState, RunInput, VersionAuthor, VersionStatus};
use eos_core::routine::{BuiltinRoutines, StepResult, SystemStepCall};
use eos_core::store::StoredRoutine;
use eos_core::{BoxFuture, Error};
use eos_domain::routine::run::{Reason, RunState, Station};
use serde_json::Value;

use super::versions::{NewVersion, insert_version, prepare};
use super::{Engine, exec, fail, project};
use crate::routes::{BUILTIN, showing_version};

/// The system step the run's milestone at work names, with the call for it.
async fn due(engine: &Engine, run_id: &str) -> Result<Option<SystemStepCall>, Error> {
    let id = run_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(run) = tx.runs().find(&id)? else { return Ok(None) };
            if (run.state, run.station) != (RunState::Running, Some(Station::Work)) {
                return Ok(None);
            }
            let Some(blueprint) = project::blueprint_in(tx, &run)? else { return Ok(None) };
            let Some(milestone) = project::current(&blueprint, &run) else { return Ok(None) };
            let Some(step) = milestone.system.clone() else { return Ok(None) };
            let input: RunInput =
                serde_json::from_str(&run.input).map_err(|_| Error::storage(format!("run {id} has no input")))?;
            Ok(Some(SystemStepCall {
                step,
                run_id: run.id,
                routine_id: run.routine_id,
                milestone: milestone.key.clone(),
                input,
            }))
        })
        .await
}

/// Whether the run's milestone at work is a system step: its lead waits.
pub(crate) async fn at_step(engine: &Engine, run_id: &str) -> bool {
    matches!(due(engine, run_id).await, Ok(Some(_)))
}

/// Runs the system step of the run's milestone at work, when it names one,
/// and hands its result in; a step that fails, fails the run.
pub(crate) fn begin(engine: &Arc<Engine>, run_id: &str) {
    let (engine, run_id) = (engine.clone(), run_id.to_owned());
    tokio::spawn(async move {
        if let Err(error) = run(&engine, &run_id).await {
            tracing::warn!(run_id, %error, "a run's system step broke");
            if let Err(error) = fail(&engine, &run_id, Reason::Internal, None).await {
                tracing::error!(run_id, %error, "a run whose system step broke could not be failed");
            }
        }
    });
}

async fn run(engine: &Arc<Engine>, run_id: &str) -> Result<(), Error> {
    let Some(call) = due(engine, run_id).await? else { return Ok(()) };
    let (step, routine_id) = (call.step.clone(), call.routine_id.clone());
    tracing::info!(run_id, step, "a run's system step started");
    match engine.system_steps.run(call).await? {
        StepResult::Done(result) => match exec::hand_in(engine, None, run_id, &routine_id, result).await {
            Ok(()) => Ok(()),
            Err(Error::Validation(reason)) => fail(engine, run_id, Reason::Reported, Some(reason)).await,
            Err(error) => Err(error),
        },
        StepResult::Failed { reason } => {
            tracing::info!(run_id, step, "a run's system step failed");
            fail(engine, run_id, Reason::Reported, Some(reason)).await
        }
    }
}

/// The routines port its features keep their built-in routines through.
pub(crate) struct Builtins(pub(crate) Arc<Engine>);

impl BuiltinRoutines for Builtins {
    fn ensure<'a>(&'a self, slug: &'a str, blueprint: Value) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(ensure(&self.0, slug, blueprint))
    }
}

async fn ensure(engine: &Arc<Engine>, slug: &str, value: Value) -> Result<String, Error> {
    let prepared = prepare(engine, value)
        .await?
        .map_err(|issues| Error::Validation(format!("the built-in routine {slug} has {} issues", issues.len())))?;
    if prepared.blueprint.kind != RoutineKind::Project {
        return Err(Error::Validation(format!("the built-in routine {slug} is no project")));
    }
    let (ids, now, device) = (engine.ids.clone(), engine.clock.now_ms(), engine.device.clone());
    let slug_owned = slug.to_owned();
    let id = engine
        .store
        .write(move |tx, _| {
            let found = tx.routines().list()?.into_iter().find(|r| r.origin == BUILTIN && r.slug == slug_owned);
            let routine_id = match &found {
                Some(routine) => routine.id.clone(),
                None => ids.routine_id(),
            };
            let shown = found.as_ref().map(|_| showing_version(tx, &routine_id)).transpose()?.flatten();
            let text = eos_domain::routine::blueprint::canonical_json(&prepared.blueprint);
            if shown.as_ref().is_some_and(|version| version.hash == eos_domain::routine::blueprint::hash(&text)) {
                return Ok(routine_id);
            }
            if found.is_none() {
                tx.routines().insert(&StoredRoutine {
                    id: routine_id.clone(),
                    slug: slug_owned.clone(),
                    name: prepared.blueprint.name.clone(),
                    kind: prepared.blueprint.kind,
                    state: RoutineState::Active,
                    paused_reason: None,
                    head_version_id: None,
                    origin: BUILTIN.to_owned(),
                    task_key: None,
                    agents_may_start: false,
                    failure_streak: 0,
                    created_at: now,
                    updated_at: now,
                    changed_at: now,
                    started_at: Some(now),
                    deleted_at: None,
                })?;
            }
            let version_id = ids.routine_version_id();
            let version = NewVersion {
                id: &version_id,
                routine_id: &routine_id,
                parent_id: shown.map(|version| version.id),
                status: VersionStatus::Kept,
                author: VersionAuthor::Eos,
                note: None,
                prepared: &prepared,
                device: &device,
                now,
            };
            insert_version(tx, version)?;
            tx.routines().set_head(&routine_id, &version_id, now)?;
            tracing::info!(routine_id, version_id, "a built-in routine was kept");
            Ok(routine_id)
        })
        .await?;
    Ok(id)
}
