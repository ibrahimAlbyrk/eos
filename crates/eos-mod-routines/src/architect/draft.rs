//! A routine's draft as the screen sees and moves it: what the architect
//! works on, a message or a choice to it, leaving the draft, and the start
//! that keeps the draft as the routine's head.

use std::sync::Arc;

use eos_contracts::{
    BlueprintIssue, DraftStatus, DraftView, RoutineChangeReason, RoutineState, RoutineSummary, VersionStatus,
};
use eos_core::Error;
use eos_core::store::{StoredDraft, Tx};
use eos_domain::routine::run::RunState;
use serde_json::{Value, json};

use super::{NO_ARCHITECT, say, suspend};
use crate::engine::{Engine, NEWER_FORMAT, announce_routine, blocks, check_in, live, row};
use crate::routes::{readable, run_summary};

/// How many of a routine's runs are read for its draft's trial runs.
const RECENT_RUNS: i64 = 50;

/// The question column holds the question with its choices, as JSON.
pub(crate) fn question_text(question: &str, choices: &[String]) -> String {
    json!({"question": question, "choices": choices}).to_string()
}

/// The question and its choices, from the question column.
pub(crate) fn question_of(stored: &str) -> (String, Vec<String>) {
    let value: Value = serde_json::from_str(stored).unwrap_or(Value::Null);
    let question = value["question"].as_str().unwrap_or(stored).to_owned();
    let choices = serde_json::from_value(value["choices"].clone()).unwrap_or_default();
    (question, choices)
}

fn draft_in(tx: &dyn Tx, routine_id: &str) -> Result<StoredDraft, Error> {
    live(tx, routine_id)?;
    tx.routines().draft(routine_id)?.ok_or_else(|| Error::not_found("draft", routine_id))
}

fn stored_json(tx: &dyn Tx, routine_id: &str, version_id: Option<&str>) -> Result<Option<Value>, Error> {
    let Some(version_id) = version_id else { return Ok(None) };
    let version = tx.routine_versions().find(routine_id, version_id)?;
    Ok(version.and_then(|version| serde_json::from_str(&version.blueprint).ok()))
}

/// The slots of `draft` that differ from `head`, in the draft's order.
fn changed(head: Option<&Value>, draft: Option<&Value>) -> Vec<String> {
    let Some(slots) = draft.and_then(Value::as_object) else { return Vec::new() };
    let differs = |slot: &str, value: &Value| head.is_none_or(|head| head.get(slot) != Some(value));
    slots
        .iter()
        .filter(|(slot, value)| *slot != "format" && differs(slot, value))
        .map(|(slot, _)| slot.clone())
        .collect()
}

/// `GET /api/routines/:id/draft`.
pub(crate) async fn view(engine: &Engine, routine_id: &str) -> Result<DraftView, Error> {
    let id = routine_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let draft = draft_in(tx, &id)?;
            let head = tx.routines().find(&id)?.and_then(|routine| routine.head_version_id);
            let draft_json = stored_json(tx, &id, draft.draft_version_id.as_deref())?;
            let head_json = stored_json(tx, &id, head.as_deref())?;
            let trial_runs = match &draft.draft_version_id {
                Some(version_id) => tx
                    .runs()
                    .by_routine(&id, RECENT_RUNS)?
                    .iter()
                    .filter(|run| run.kind == "trial" && run.version_id.as_ref() == Some(version_id))
                    .map(run_summary)
                    .collect(),
                None => Vec::new(),
            };
            let (question, choices) = match draft.question.as_deref().map(question_of) {
                Some((question, choices)) => (Some(question), choices),
                None => (None, Vec::new()),
            };
            Ok(DraftView {
                purpose: draft.purpose,
                status: draft.status,
                question,
                choices,
                base_version_id: draft.base_version_id,
                draft_version_id: draft.draft_version_id,
                trial_runs,
                changed: changed(head_json.as_ref(), draft_json.as_ref()),
                updated_at: draft.updated_at,
            })
        })
        .await
}

/// Writes the draft row as `change` leaves it and announces it; the
/// architect it names.
async fn update(
    engine: &Engine,
    routine_id: &str,
    change: impl FnOnce(&mut StoredDraft) + Send + 'static,
) -> Result<Option<String>, Error> {
    let (id, now) = (routine_id.to_owned(), engine.clock.now_ms());
    engine
        .store
        .write(move |tx, out| {
            let mut draft = draft_in(tx, &id)?;
            change(&mut draft);
            draft.updated_at = now;
            tx.routines().update_draft(&draft)?;
            announce_routine(tx, out, &id, RoutineChangeReason::Draft, now)?;
            Ok(draft.architect_id)
        })
        .await
}

/// `POST /api/routines/:id/draft/message`: the user's words, or the choice
/// that answers the architect's question, as the user's next message.
pub(crate) async fn message(engine: &Engine, routine_id: &str, text: &str) -> Result<DraftView, Error> {
    let architect = update(engine, routine_id, |draft| {
        draft.question = None;
        draft.status = DraftStatus::Working;
    })
    .await?;
    let architect = architect.ok_or_else(|| Error::Conflict(NO_ARCHITECT.into()))?;
    say(engine, &architect, text).await?;
    view(engine, routine_id).await
}

/// `DELETE /api/routines/:id/draft`: the draft is left and its architect
/// suspended; the routine stays as it is.
pub(crate) async fn abandon(engine: &Engine, routine_id: &str) -> Result<DraftView, Error> {
    let architect = update(engine, routine_id, |draft| {
        draft.question = None;
        draft.status = DraftStatus::Abandoned;
    })
    .await?;
    if let Some(architect) = architect {
        suspend(engine, &architect).await;
    }
    tracing::info!(routine_id, "a routine's draft was left");
    view(engine, routine_id).await
}

/// What a start comes to.
pub(crate) enum Started {
    Kept(Box<Option<RoutineSummary>>),
    /// The draft does not meet its rules; nothing was written.
    Refused(Vec<BlueprintIssue>),
    /// No trial of the draft went well, and the user did not choose to
    /// start without one (G45).
    NeedsTrial,
}

/// Whether a trial run of `version_id` ended done.
fn tried(tx: &dyn Tx, routine_id: &str, version_id: &str) -> Result<bool, Error> {
    let runs = tx.runs().by_routine(routine_id, RECENT_RUNS)?;
    Ok(runs
        .iter()
        .any(|run| run.kind == "trial" && run.version_id.as_deref() == Some(version_id) && run.state == RunState::Done))
}

/// The version a start keeps: for a routine still being made, its newest
/// draft version, the one the editor shows, whether the architect or the
/// user wrote it; for a started routine, the architect's draft of a change.
fn to_start(tx: &dyn Tx, routine_id: &str, state: RoutineState) -> Result<Option<String>, Error> {
    if state == RoutineState::Draft {
        let versions = tx.routine_versions().list(routine_id)?;
        let newest = versions.into_iter().rev().find(|version| version.status == VersionStatus::Draft);
        return Ok(newest.map(|version| version.id));
    }
    let draft = tx.routines().draft(routine_id)?.filter(|draft| draft.status != DraftStatus::Abandoned);
    Ok(draft.and_then(|draft| draft.draft_version_id))
}

/// `POST /api/routines/:id/start`: the draft version becomes kept and the
/// routine's head, the routine active, and its architect is suspended.
pub(crate) async fn start(engine: &Arc<Engine>, routine_id: &str, without_trial: bool) -> Result<Started, Error> {
    let (id, now, zones) = (routine_id.to_owned(), engine.clock.now_ms(), engine.zones.clone());
    let started = engine
        .store
        .write(move |tx, out| {
            let routine = live(tx, &id)?;
            if tx.routine_versions().head(&id)?.map(|head| readable(&head)).transpose()?.is_some_and(|b| b.is_none()) {
                return Err(Error::Conflict(NEWER_FORMAT.into()));
            }
            let version_id = to_start(tx, &id, routine.state)?
                .ok_or_else(|| Error::Conflict("there is no draft to start".into()))?;
            let version = tx.routine_versions().find(&id, &version_id)?;
            let version = version.ok_or_else(|| Error::not_found("version", version_id.clone()))?;
            let blueprint = readable(&version)?.ok_or_else(|| Error::Conflict(NEWER_FORMAT.into()))?;
            let issues = check_in(tx, &id, &blueprint, zones.as_ref())?;
            if blocks(&issues) {
                return Ok((Started::Refused(issues), None));
            }
            if !without_trial && !tried(tx, &id, &version_id)? {
                return Ok((Started::NeedsTrial, None));
            }
            tx.routine_versions().keep(&id, &version_id, without_trial)?;
            tx.routines().set_head(&id, &version_id, now)?;
            if routine.state == RoutineState::Draft {
                tx.routines().set_state(&id, RoutineState::Active, None, now)?;
            }
            if routine.name != blueprint.name {
                tx.routines().set_name(&id, &blueprint.name, now)?;
            }
            if routine.kind != blueprint.kind {
                tx.routines().set_kind(&id, blueprint.kind, now)?;
            }
            let mut architect = None;
            if let Some(mut draft) = tx.routines().draft(&id)? {
                architect = draft.architect_id.clone();
                draft.base_version_id = Some(version_id.clone());
                draft.draft_version_id = None;
                draft.question = None;
                draft.status = DraftStatus::Ready;
                draft.updated_at = now;
                tx.routines().update_draft(&draft)?;
            }
            tracing::info!(routine_id = %id, version_id = %version_id, without_trial, "a routine was started");
            announce_routine(tx, out, &id, RoutineChangeReason::Version, now)?;
            Ok((Started::Kept(Box::new(row(tx, &id, now)?)), architect))
        })
        .await?;
    let (started, architect) = started;
    if let Some(architect) = architect {
        suspend(engine, &architect).await;
    }
    engine.wake.notify_one();
    Ok(started)
}
