//! What routines keep, and for how long (01 G6, G11): one pass at start
//! and then once a day, from the supervisor's turn, on the engine's clock.
//!
//! - The agent transcripts of a run's sessions go [`TRANSCRIPTS_KEPT_DAYS`]
//!   after the run ended, through the session service's removal (the one
//!   that removes a chat), so the engine deletes what it recorded; the run's
//!   summary, result and timeline stay.
//! - A run goes once it is neither among its routine's newest
//!   [`RUNS_KEPT`] nor ended within [`RUNS_KEPT_DAYS`]; a run that has not
//!   ended (one waiting for the user too) never does. Its folder goes to the
//!   trash; its timeline, results, sessions, deliveries, edits and outcomes
//!   go with its row, except the outcomes of its routine's first week, the
//!   baseline of its numbers.
//! - A routine leaves for good [`DELETED_KEPT_DAYS`] after it was deleted,
//!   a one-off [`ONE_OFF_KEPT_DAYS`] after its run ended unless the user
//!   kept it, and a routine never started [`DRAFTS_KEPT_DAYS`] after its
//!   draft was left: its folder goes to the trash and every row of it goes.
//!   A deleted routine first leaves one export in the trash, its versions
//!   and run summaries as JSON, from which it can be brought back.
//!
//! Each page of [`PAGE`] rows is read, its files moved, then its rows
//! deleted in one write job. A run or routine whose files or sessions
//! could not be cleared keeps its rows for the next pass; the others go on.

use std::sync::Arc;

use eos_contracts::{RoutineChange, RoutineChangeReason, RoutineState, RunSummary};
use eos_core::Error;
use eos_core::store::{EndedRun, Leaving, LeavingRoutine, Tx};
use serde_json::json;
use tokio::task::JoinHandle;

use crate::ROUTINE_CHANGE;
use crate::engine::Engine;
use crate::routes::{run_summary, with_blueprint};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub(crate) const RUNS_KEPT: i64 = 500;
pub(crate) const RUNS_KEPT_DAYS: i64 = 90;
pub(crate) const TRANSCRIPTS_KEPT_DAYS: i64 = 14;
pub(crate) const ONE_OFF_KEPT_DAYS: i64 = 7;
pub(crate) const DRAFTS_KEPT_DAYS: i64 = 30;
pub(crate) const DELETED_KEPT_DAYS: i64 = 30;
/// How long a deleted routine stays in Recently deleted.
pub(crate) const DELETED_KEPT_MS: i64 = DELETED_KEPT_DAYS * DAY_MS;
pub(crate) const PAGE: i64 = 1_000;

/// When the pass is next due, and the one at work.
#[derive(Debug, Default)]
pub(crate) struct Schedule {
    next_at: i64,
    task: Option<JoinHandle<()>>,
}

/// Starts a pass when one is due and none is at work.
pub(crate) fn due(engine: &Arc<Engine>) {
    let now = engine.clock.now_ms();
    let mut schedule = Engine::locked(&engine.retention);
    if now < schedule.next_at || schedule.task.as_ref().is_some_and(|task| !task.is_finished()) {
        return;
    }
    schedule.next_at = now + DAY_MS;
    schedule.task = Some(tokio::spawn(pass(engine.clone(), now)));
}

/// Ends the pass at work, if any.
pub(crate) async fn stop(engine: &Engine) {
    let task = Engine::locked(&engine.retention).task.take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

/// What one pass cleared, and how much it left for the next.
#[derive(Debug, Default)]
struct Cleared {
    transcripts: usize,
    runs: usize,
    routines: usize,
    left: usize,
}

async fn pass(engine: Arc<Engine>, now: i64) {
    let mut cleared = Cleared::default();
    transcripts(&engine, now - TRANSCRIPTS_KEPT_DAYS * DAY_MS, &mut cleared).await;
    runs(&engine, now - RUNS_KEPT_DAYS * DAY_MS, &mut cleared).await;
    let when = Leaving {
        deleted_by: now - DELETED_KEPT_MS,
        once_by: now - ONE_OFF_KEPT_DAYS * DAY_MS,
        draft_by: now - DRAFTS_KEPT_DAYS * DAY_MS,
    };
    routines(&engine, &when, &mut cleared).await;
    let Cleared { transcripts, runs, routines, left } = cleared;
    if transcripts + runs + routines + left > 0 {
        let ms = engine.clock.now_ms() - now;
        tracing::info!(transcripts, runs, routines, left, ms, "old routine history was cleared");
    }
}

fn kind(error: &Error) -> &'static str {
    match error {
        Error::NotFound { .. } => "not_found",
        Error::Conflict(_) => "conflict",
        Error::Validation(_) => "validation",
        Error::PermissionDenied(_) => "permission_denied",
        Error::LimitExceeded(_) => "limit_exceeded",
        Error::Unreachable(_) => "unreachable",
        Error::Rule(_) => "rule",
        Error::Storage(_) => "storage",
    }
}

fn warn(what: &'static str, error: &Error) {
    tracing::warn!(what, error = kind(error), "old routine history could not be cleared");
}

/// Removes a session's worker and its recorded conversation. True when it
/// was there and is gone; an error when it is still there.
async fn forget(engine: &Engine, worker_id: &str) -> Result<bool, Error> {
    match engine.sessions.kill(worker_id).await {
        Ok(_) => Ok(true),
        // Removed with the lead that started it, or before.
        Err(Error::NotFound { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn transcripts(engine: &Engine, ended_by: i64, cleared: &mut Cleared) {
    let mut after = String::new();
    loop {
        let from = after.clone();
        let read = engine.store.read(move |tx| tx.routine_retention().transcripts_past(ended_by, &from, PAGE)).await;
        let page = match read {
            Ok(page) => page,
            Err(error) => return warn("transcripts", &error),
        };
        for worker_id in &page {
            match forget(engine, worker_id).await {
                Ok(gone) => cleared.transcripts += usize::from(gone),
                Err(error) => {
                    warn("transcript", &error);
                    cleared.left += 1;
                }
            }
        }
        match page.last() {
            Some(last) if page.len() as i64 == PAGE => after.clone_from(last),
            _ => return,
        }
    }
}

async fn runs(engine: &Engine, ended_by: i64, cleared: &mut Cleared) {
    let mut after: Option<(i64, String)> = None;
    loop {
        let from = after.clone();
        let read = engine
            .store
            .read(move |tx| {
                let from = from.as_ref().map(|(at, id)| (*at, id.as_str()));
                tx.routine_retention().runs_past(RUNS_KEPT, ended_by, from, PAGE)
            })
            .await;
        let page = match read {
            Ok(page) => page,
            Err(error) => return warn("runs", &error),
        };
        let mut going = Vec::new();
        for run in &page {
            match clear_run(engine, run).await {
                Ok(()) => going.push(run.id.clone()),
                Err(error) => {
                    warn("run", &error);
                    cleared.left += 1;
                }
            }
        }
        if !going.is_empty() {
            let count = going.len();
            match engine.store.write(move |tx, _| tx.routine_retention().delete_runs(&going)).await {
                Ok(deleted) => cleared.runs += deleted,
                Err(error) => {
                    warn("runs", &error);
                    cleared.left += count;
                }
            }
        }
        match page.last() {
            Some(last) if page.len() as i64 == PAGE => after = Some((last.ended_at, last.id.clone())),
            _ => return,
        }
    }
}

/// What a run leaves outside its rows: a session the transcript purge left,
/// and its folder.
async fn clear_run(engine: &Engine, run: &EndedRun) -> Result<(), Error> {
    let id = run.id.clone();
    let sessions = engine.store.read(move |tx| tx.routine_sessions().by_run(&id)).await?;
    for session in sessions {
        forget(engine, &session.worker_id).await?;
    }
    trash_folder(engine, &engine.folders.run_dir(&run.routine_id, &run.id)).await
}

async fn trash_folder(engine: &Engine, dir: &std::path::Path) -> Result<(), Error> {
    if engine.trash.exists(dir).await { engine.trash.trash(dir).await } else { Ok(()) }
}

async fn routines(engine: &Engine, when: &Leaving, cleared: &mut Cleared) {
    let mut after = String::new();
    loop {
        let (from, when) = (after.clone(), *when);
        let read = engine.store.read(move |tx| tx.routine_retention().leaving(&when, &from, PAGE)).await;
        let page = match read {
            Ok(page) => page,
            Err(error) => return warn("routines", &error),
        };
        for routine in &page {
            match remove(engine, routine).await {
                Ok(()) => {
                    tracing::info!(routine_id = %routine.id, state = ?routine.state, "a routine left for good");
                    cleared.routines += 1;
                }
                Err(error) => {
                    warn("routine", &error);
                    cleared.left += 1;
                }
            }
        }
        match page.last() {
            Some(last) if page.len() as i64 == PAGE => after.clone_from(&last.id),
            _ => return,
        }
    }
}

/// A routine leaves: its export first (a deleted one), then its sessions,
/// its folder and, page by page, its rows.
async fn remove(engine: &Engine, routine: &LeavingRoutine) -> Result<(), Error> {
    if routine.state == RoutineState::Deleted {
        export(engine, routine).await?;
    }
    let id = routine.id.clone();
    for worker_id in engine.store.read(move |tx| tx.routine_retention().workers_of(&id)).await? {
        forget(engine, &worker_id).await?;
    }
    trash_folder(engine, &engine.folders.routine_dir(&routine.id)).await?;
    loop {
        let id = routine.id.clone();
        let deleted = engine.store.write(move |tx, _| tx.routine_retention().delete_runs_of(&id, PAGE)).await?;
        if (deleted as i64) < PAGE {
            break;
        }
    }
    let (id, shown) = (routine.id.clone(), routine.state != RoutineState::Deleted);
    engine
        .store
        .write(move |tx, out| {
            tx.routine_retention().delete_routine(&id)?;
            if shown {
                let change = RoutineChange { routine_id: id, reason: RoutineChangeReason::Deleted, row: None };
                out.push(ROUTINE_CHANGE.name(), &change);
            }
            Ok(())
        })
        .await
}

/// One file in the trash: `<name> (Eos routine).json`.
async fn export(engine: &Engine, routine: &LeavingRoutine) -> Result<(), Error> {
    let id = routine.id.clone();
    let bytes = engine.store.read(move |tx| export_in(tx, &id)).await?;
    let name = format!("{} (Eos routine).json", file_name(&routine.name));
    let path = engine.trash.write_temp("eos-routine-", &name, &bytes).await?;
    engine.trash.trash(&path).await
}

fn export_in(tx: &dyn Tx, routine_id: &str) -> Result<Vec<u8>, Error> {
    let routine = tx.routines().find(routine_id)?.ok_or_else(|| Error::not_found("routine", routine_id))?;
    let stored = tx.routine_versions().list(routine_id)?;
    let versions =
        stored.iter().enumerate().map(|(at, version)| with_blueprint(at, version)).collect::<Result<Vec<_>, _>>()?;
    let runs: Vec<RunSummary> = tx.runs().by_routine(routine_id, i64::MAX)?.iter().map(run_summary).collect();
    let export = json!({
        "format": 1,
        "routine": {
            "id": routine.id,
            "name": routine.name,
            "kind": routine.kind,
            "createdAt": routine.created_at,
            "deletedAt": routine.deleted_at,
        },
        "versions": versions,
        "runs": runs,
    });
    serde_json::to_vec_pretty(&export).map_err(Error::storage)
}

/// The routine's name as a file name: no folder separators.
fn file_name(name: &str) -> String {
    let name: String = name.chars().map(|c| if matches!(c, '/' | ':' | '\\') { '-' } else { c }).collect();
    let name = name.trim().trim_start_matches('.');
    if name.is_empty() { "Routine".to_owned() } else { name.to_owned() }
}
