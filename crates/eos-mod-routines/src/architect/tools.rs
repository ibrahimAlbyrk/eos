//! What the architect's tools do. Each call is the architect's activity: its
//! idle time starts again.

use std::sync::Arc;

use eos_contracts::{DraftStatus, ItemRef, RoutineChangeReason};
use eos_core::routine::{ArchitectTools, Proposal, StartError};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};

use super::draft::{question_of, question_text};
use super::{draft_of, propose, touch};
use crate::engine::{Engine, NEWER_FORMAT, announce_routine};
use crate::routes::readable;
use crate::trial;

/// How many trial runs `get_routine` shows.
const TRIAL_RUNS_SHOWN: usize = 6;

pub(crate) struct Architect(pub(crate) Arc<Engine>);

/// A stored blueprint as the model reads it.
fn blueprint_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

async fn get_routine(engine: &Engine, worker_id: &str) -> Result<Value, Error> {
    touch(engine, worker_id);
    let worker = worker_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let draft = draft_of(tx, &worker)?;
            let id = draft.routine_id.clone();
            let routine = tx.routines().find(&id)?.ok_or_else(|| Error::not_found("routine", &id))?;
            let head = tx.routine_versions().head(&id)?;
            let drafted = match &draft.draft_version_id {
                Some(version_id) => tx.routine_versions().find(&id, version_id)?,
                None => None,
            };
            let trials: Vec<Value> = tx
                .runs()
                .by_routine(&id, 50)?
                .iter()
                .filter(|run| run.kind == "trial")
                .take(TRIAL_RUNS_SHOWN)
                .map(|run| {
                    json!({"id": run.id, "state": run.state.as_str(), "outcome": run.outcome.map(|o| o.as_str()),
                           "headline": run.headline})
                })
                .collect();
            let question = draft.question.as_deref().map(question_of).map(|(question, choices)| {
                json!({"question": question, "choices": choices})
            });
            Ok(json!({
                "id": id,
                "name": routine.name,
                "state": routine.state,
                "purpose": draft.purpose,
                "head": head.map(|version| blueprint_json(&version.blueprint)),
                "draft": drafted.map(|version| json!({"versionId": version.id, "blueprint": blueprint_json(&version.blueprint)})),
                "openQuestion": question,
                "trialRuns": trials,
            }))
        })
        .await
}

async fn ask_choice(engine: &Engine, worker_id: &str, question: &str, choices: &[String]) -> Result<(), Error> {
    touch(engine, worker_id);
    let (worker, stored, now) = (worker_id.to_owned(), question_text(question, choices), engine.clock.now_ms());
    let patterns = engine.patterns.clone();
    engine
        .store
        .write(move |tx, out| {
            let mut draft = draft_of(tx, &worker)?;
            draft.question = Some(stored);
            draft.status = DraftStatus::Asking;
            draft.updated_at = now;
            tx.routines().update_draft(&draft)?;
            announce_routine(tx, out, &draft.routine_id, RoutineChangeReason::Draft, now, &patterns)
        })
        .await
}

/// The routine the architect works on, with the blueprint a trial runs.
async fn routine_of(engine: &Engine, worker_id: &str) -> Result<(String, eos_contracts::Blueprint), Error> {
    touch(engine, worker_id);
    let worker = worker_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let id = draft_of(tx, &worker)?.routine_id;
            let version = trial::version_in(tx, &id)?.ok_or_else(|| Error::not_found("routine", &id))?;
            let blueprint = readable(&version)?.ok_or_else(|| Error::Conflict(NEWER_FORMAT.into()))?;
            Ok((id, blueprint))
        })
        .await
}

async fn find_past_items(engine: &Engine, worker_id: &str, limit: usize) -> Result<Vec<ItemRef>, Error> {
    let (_, blueprint) = routine_of(engine, worker_id).await?;
    trial::past_items(engine, &blueprint, limit).await
}

async fn start_trial(engine: &Arc<Engine>, worker_id: &str) -> Result<Vec<String>, Error> {
    let (routine_id, _) = routine_of(engine, worker_id).await?;
    match trial::start(engine, &routine_id).await {
        Ok(runs) => Ok(runs.into_iter().map(|run| run.id).collect()),
        Err(StartError::Store(error)) => Err(error),
        Err(StartError::UnknownRoutine(id)) => Err(Error::not_found("routine", id)),
        Err(StartError::DayCap) => Err(Error::Conflict("routines spent today's budget".into())),
        Err(StartError::Halted) => Err(Error::Conflict("Eos is stopped".into())),
        Err(StartError::NewerFormat) => Err(Error::Conflict(NEWER_FORMAT.into())),
        Err(StartError::RoutineState(_)) => Err(Error::Conflict("the routine does not take a trial now".into())),
        Err(StartError::SameItem { .. }) => Err(Error::Conflict("the routine works on that item now".into())),
        Err(StartError::Invalid(text)) => Err(Error::Validation(text)),
        Err(StartError::Unready(unready)) => {
            Err(Error::Conflict(format!("No trial run was started. Tell the user: {}", unready.message())))
        }
    }
}

impl ArchitectTools for Architect {
    fn get_routine<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Value, Error>> {
        Box::pin(get_routine(&self.0, worker_id))
    }

    fn propose_blueprint<'a>(
        &'a self,
        worker_id: &'a str,
        blueprint: Value,
        note: Option<String>,
    ) -> BoxFuture<'a, Result<Proposal, Error>> {
        Box::pin(propose::propose(&self.0, worker_id, blueprint, note))
    }

    fn ask_choice<'a>(
        &'a self,
        worker_id: &'a str,
        question: &'a str,
        choices: &'a [String],
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(ask_choice(&self.0, worker_id, question, choices))
    }

    fn find_past_items<'a>(&'a self, worker_id: &'a str, limit: usize) -> BoxFuture<'a, Result<Vec<ItemRef>, Error>> {
        Box::pin(find_past_items(&self.0, worker_id, limit))
    }

    fn start_trial<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>> {
        Box::pin(start_trial(&self.0, worker_id))
    }
}
