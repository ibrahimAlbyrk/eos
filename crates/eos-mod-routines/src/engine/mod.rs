//! The run engine: starting runs (`start`), the supervisor that takes them
//! out of the queue (`supervisor`), the brief station that starts a run's
//! lead (`brief`), what the lead's tools do (`exec`), what happens when the
//! lead goes quiet or its session dies (`idle`), stopping runs
//! (`cancel`) and stopping every run at work when the user stops
//! everything (`halt`). Every move of a run is one write job that adds the move to
//! the run's timeline and announces it on `run:change` from the job's
//! outbox.

mod activity;
mod app_review;
mod brief;
mod budget;
mod cancel;
mod check;
mod control;
mod defaults;
mod exec;
mod failures;
mod folders;
mod gate;
mod grants;
mod halt;
mod handoffs;
mod idle;
mod launch;
mod lifecycle;
mod memory;
mod outcomes;
mod ports;
mod project;
mod ready;
mod recover;
mod script;
mod shape;
mod spawn;
mod start;
mod steer;
mod supervisor;
pub(crate) mod surfaces;
mod system;
mod team;
mod uncap;
mod versions;
mod workspace;

pub(crate) use activity::seen as agent_event;
pub(crate) use app_review::AppReviews;
pub(crate) use brief::model_of;
pub(crate) use budget::watch_usage;
pub(crate) use check::holds;
pub(crate) use control::{Control, announce as announce_routine, confirmed_in};
pub(crate) use exec::Tools;
pub(crate) use grants::Grants;
pub(crate) use halt::hear as hear_halt;
pub(crate) use handoffs::hear as hear_answers;
pub(crate) use idle::{lead_idle_hook, session_exited};
pub(crate) use launch::{rebuild as rebuild_launches, shape as shape_launch};
pub(crate) use lifecycle::{delete, editable, keep, keep_in, live, row, set_state, undelete};
pub(crate) use memory::routine_removed;
pub(crate) use outcomes::Outcomes;
pub(crate) use ports::{Directory, Intake, Lookup};
pub(crate) use recover::recover;
pub(crate) use script::Scripts;
pub(crate) use start::start as start_runs;
pub(crate) use start::{queue_with as queue_runs_in, ready_for as ready_to_start, taking as taking_starts};
pub(crate) use steer::{message, pause, resume};
pub(crate) use surfaces::{Move as SurfaceMove, moved as surface_moved};
pub(crate) use system::Builtins;
pub(crate) use team::shape_report;
pub(crate) use uncap::uncap;
pub(crate) use versions::{
    Edit, NEWER_FORMAT, NewVersion, Prepared, Saved, blocks, check_in, copy, create, free_slug, insert_version,
    prepare, restore, save,
};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{RunChange, RunInput, RunsActive};
use eos_core::accounts::SessionCredentials;
use eos_core::agent::{OneShot, ScratchFolders};
use eos_core::capability::CapabilityReads;
use eos_core::experience::{ExperienceFeedback, ExperiencePacks};
use eos_core::git::{ProjectKeys, RemoteSync};
use eos_core::os::{FileSystem, Power, TimeZone, ZoneRules};
use eos_core::routine::{PlanHeadroom, RunCreated, RunFolders, RunGate, SystemSteps};
use eos_core::store::{ConfigSource, Outbox, RUN_STATE_EVENT, RunMove, Store, StoredRun, Tx, UserSettingsStore};
use eos_core::surface::SurfaceAuthoring;
use eos_core::{Clock, Error, Ids, Sleeper};
use eos_domain::envelope::Envelope;
use eos_domain::routine::run::{Reason, RunState};
use eos_prompts::PromptService;
use eos_runtime::bus::{Bus, Subscription};
use eos_sessions::{MessageInput, Sessions};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::{RUN_CHANGE, RUNS_ACTIVE};

/// What the engine is built from.
pub(crate) struct Engine {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) ids: Arc<dyn Ids>,
    /// This computer's id, stored on each run it makes.
    pub(crate) device: String,
    /// Off the network only runs the user started leave the queue by
    /// themselves (`Reach::autostart`).
    pub(crate) autostart: bool,
    /// Off the network Eos never calls the model by itself
    /// (`Reach::background_model_calls`).
    pub(crate) background_model_calls: bool,
    /// Wakes the supervisor: a run was queued or ended.
    pub(crate) wake: Notify,
    /// Client request ids of the last ten minutes, with the runs they made.
    pub(crate) requests: Mutex<HashMap<String, (i64, Vec<RunCreated>)>>,
    pub(crate) supervisor: Mutex<Option<JoinHandle<()>>>,
    /// Where run sessions are started and messaged.
    pub(crate) sessions: Sessions,
    /// The run brief and the other texts sessions are started with.
    pub(crate) prompts: Arc<PromptService>,
    /// The folder of an agent whose workspace is none.
    pub(crate) scratch: Arc<dyn ScratchFolders>,
    pub(crate) folders: Arc<dyn RunFolders>,
    /// Each working run's latest progress line, never stored or logged.
    pub(crate) progress: Mutex<HashMap<String, String>>,
    /// How each run session starts, by worker.
    pub(crate) launches: Mutex<HashMap<String, launch::RunLaunch>>,
    /// The capabilities there are, for what a run session may call.
    pub(crate) reads: Arc<dyn CapabilityReads>,
    /// The item patterns each routine row carries.
    pub(crate) patterns: Arc<crate::patterns::ItemPatterns>,
    /// Leads Eos owes a word before they go on: messages to them queue.
    pub(crate) held: Mutex<HashSet<String>>,
    /// Specialists being started, by their lead and agent key: a second start of one is refused.
    pub(crate) starting: Mutex<HashSet<(String, String)>>,
    /// Where a handed-in result goes.
    pub(crate) gate: Arc<dyn RunGate>,
    /// Model prices, for the estimate.
    pub(crate) config: Arc<dyn ConfigSource>,
    /// The runtime the module was built in, for what follows a commit.
    pub(crate) tasks: Option<tokio::runtime::Handle>,
    /// Where the user's clone of a repository is.
    pub(crate) keys: Arc<dyn ProjectKeys>,
    /// Fetches a pull request's head into that clone.
    pub(crate) remotes: Arc<dyn RemoteSync>,
    /// The first line of each specialist's last report, never stored or logged.
    pub(crate) reports: Mutex<HashMap<String, String>>,
    /// Where `run:activity` goes out.
    pub(crate) bus: Bus,
    /// When each run's last activity line went out.
    pub(crate) activity: Mutex<HashMap<String, i64>>,
    /// Ends a run's sessions once the run has ended.
    pub(crate) ended: Mutex<Option<Subscription>>,
    /// Ends the runs at work when the user stops everything.
    pub(crate) halt: Mutex<Option<Subscription>>,
    /// Acts on the user's answers to the routines' items.
    pub(crate) handoffs: Mutex<Option<Subscription>>,
    /// One pass over those answers at a time.
    pub(crate) handing: tokio::sync::Mutex<()>,
    /// The power source: triggered runs wait on a low battery.
    pub(crate) power: Arc<dyn Power>,
    /// The time zones the system knows, for a blueprint's schedules.
    pub(crate) zones: Arc<dyn ZoneRules>,
    /// Eos's data folder, which no folder trigger may watch.
    pub(crate) data_dir: PathBuf,
    /// The user's clock, for the day spend is booked on.
    pub(crate) zone: Arc<dyn TimeZone>,
    /// `settings.json`, where the budgets for all routines are.
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    /// Whether the plan has room for runs from triggers.
    pub(crate) headroom: Arc<dyn PlanHeadroom>,
    /// What each working run was told of its budget.
    pub(crate) meters: Mutex<HashMap<String, budget::Meter>>,
    /// Books what routine sessions spend.
    pub(crate) usage: Mutex<Option<Subscription>>,
    /// The live architects, with when each was last active.
    pub(crate) architects: Mutex<HashMap<String, i64>>,
    pub(crate) one_shot: Arc<dyn OneShot>,
    pub(crate) credentials: Arc<dyn SessionCredentials>,
    /// The model reads of the Home input today: the local day and how many.
    pub(crate) intent_reads: Mutex<Option<(String, i64)>>,
    /// Where what the retention pass clears goes: the trash; also how many
    /// entries a folder trigger's folder holds.
    pub(crate) trash: Arc<dyn FileSystem>,
    /// When the retention pass is next due, and the one at work.
    pub(crate) retention: Mutex<crate::retention::Schedule>,
    /// When the night's suggestion read last looked, and the one at work.
    pub(crate) suggest: Mutex<crate::suggest::Schedule>,
    pub(crate) packs: Arc<dyn ExperiencePacks>,
    pub(crate) feedback: Arc<dyn ExperienceFeedback>,
    pub(crate) surfaces: Arc<dyn SurfaceAuthoring>,
    /// The steps the features that own built-in routines run.
    pub(crate) system_steps: Arc<dyn SystemSteps>,
}

impl Engine {
    pub(crate) fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Moves `run` and announces it. The move must be one
/// `RunState::can_become` allows, or one to another station in the same
/// state.
pub(crate) fn move_run(tx: &dyn Tx, out: &mut Outbox, run: &StoredRun, change: RunMove) -> Result<i64, Error> {
    let station_move = run.state == change.state && !run.state.is_terminal();
    if !station_move && !run.state.can_become(change.state) {
        return Err(Error::Conflict(format!(
            "a run that is {} cannot become {}",
            run.state.as_str(),
            change.state.as_str()
        )));
    }
    let before = tx.runs().active()?;
    let event = tx.runs().move_to(&run.id, &change)?;
    if run.state == RunState::Queued && change.state != RunState::Queued {
        eos_inbox::withdraw_run_start_in(tx, out, change.at, &run.routine_id, &run.id)?;
    }
    budget::recount_in(tx, &run.id)?;
    announce(out, &run.id, &run.routine_id, &change);
    let after = tx.runs().active()?;
    if after != before {
        out.push(RUNS_ACTIVE.name(), &RunsActive { count: after.0, needs_user: after.1 });
    }
    Ok(event)
}

/// Ends a run that has not ended as failed, with `headline` as what the
/// user reads first; a run that ended meanwhile stays as it is.
pub(crate) async fn fail(
    engine: &Arc<Engine>,
    run_id: &str,
    reason: Reason,
    headline: Option<String>,
) -> Result<(), Error> {
    let (id, now, job) = (run_id.to_owned(), engine.clock.now_ms(), engine.clone());
    let failed = engine
        .store
        .write(move |tx, out| {
            let Some(run) = tx.runs().find(&id)?.filter(|run| run.state.can_become(RunState::Failed)) else {
                return Ok(false);
            };
            if let Some(headline) = &headline {
                tx.runs().set_headline(&id, headline)?;
            }
            let failed = RunMove { state: RunState::Failed, station: run.station, reason: Some(reason), at: now };
            move_run(tx, out, &run, failed)?;
            failures::ended_in(&job, tx, out, &id, now)?;
            Ok(true)
        })
        .await?;
    if failed {
        Engine::locked(&engine.progress).remove(run_id);
        tracing::info!(run_id, reason = reason.as_str(), "a run failed");
        // A slot is free.
        engine.wake.notify_one();
    }
    Ok(())
}

/// Sends Eos's own words to one of a run's sessions, after its turn when it
/// is busy; a session that ended comes back for it.
pub(crate) async fn note(engine: &Engine, worker_id: &str, run_id: &str, text: &str) -> Result<(), Error> {
    send_note(engine, worker_id, run_id, text, false).await
}

/// [`note`] with the user's words in it.
pub(crate) async fn user_note(engine: &Engine, worker_id: &str, run_id: &str, text: &str) -> Result<(), Error> {
    send_note(engine, worker_id, run_id, text, true).await
}

async fn send_note(engine: &Engine, worker_id: &str, run_id: &str, text: &str, from_user: bool) -> Result<(), Error> {
    let message = MessageInput {
        worker_id: worker_id.to_owned(),
        text: text.to_owned(),
        display_text: Some(text.to_owned()),
        queue_when_busy: true,
        origin: Some("routine".into()),
        envelope: Some(Envelope::RoutineNote { run_id: run_id.to_owned(), from_user, chat: None }),
        ..MessageInput::default()
    };
    engine.sessions.dispatch(message).await.map(drop)
}

/// An item as a run's brief shows it: its fields one a line, inside 03's
/// untrusted wrapper when it came from outside.
pub(crate) fn item_text(item: &eos_contracts::ItemRef) -> String {
    let mut lines = vec![format!("kind: {}", item.kind)];
    let fields = [
        ("key", &item.key),
        ("title", &item.title),
        ("url", &item.url),
        ("path", &item.path),
        ("date", &item.date),
        ("version", &item.version),
        ("text", &item.text),
    ];
    lines.extend(fields.iter().filter_map(|(name, value)| value.as_ref().map(|value| format!("{name}: {value}"))));
    let text = lines.join("\n");
    if item.untrusted { eos_domain::untrusted::wrap(item.key.as_deref().unwrap_or(&item.kind), &text) } else { text }
}

/// A run about to be queued.
pub(crate) struct Queued<'a> {
    pub(crate) id: String,
    pub(crate) routine_id: &'a str,
    /// The version it runs, when bound before it leaves the queue.
    pub(crate) version_id: Option<String>,
    pub(crate) kind: &'a str,
    pub(crate) origin: &'a str,
    pub(crate) origin_ref: Option<String>,
    pub(crate) door: Option<String>,
    pub(crate) input: &'a RunInput,
    pub(crate) item_key: Option<String>,
    pub(crate) priority: i64,
    pub(crate) device: &'a str,
    pub(crate) now: i64,
}

/// Writes a queued run with the first event of its timeline, and announces
/// it. A queued run changes nothing `runs:active` counts.
pub(crate) fn queue_run(tx: &dyn Tx, out: &mut Outbox, run: Queued<'_>) -> Result<(), Error> {
    let row = StoredRun {
        id: run.id.clone(),
        routine_id: run.routine_id.to_owned(),
        version_id: run.version_id,
        kind: run.kind.to_owned(),
        origin: run.origin.to_owned(),
        origin_ref: run.origin_ref,
        door: run.door,
        input: serde_json::to_string(run.input).map_err(|e| Error::storage(e.to_string()))?,
        item_key: run.item_key,
        state: RunState::Queued,
        station: None,
        reason: None,
        attempt: 1,
        resumed: 0,
        not_before: run.input.at,
        priority: run.priority,
        progress_done: None,
        progress_total: None,
        headline: None,
        outcome: None,
        cost_usd: 0.0,
        work_ms: 0,
        lead_id: None,
        device: run.device.to_owned(),
        remote: false,
        created_at: run.now,
        started_at: None,
        ended_at: None,
        updated_at: run.now,
    };
    tx.runs().insert(&row)?;
    tx.runs().append_event(&run.id, run.now, RUN_STATE_EVENT, Some(r#"{"state":"queued"}"#))?;
    let queued = RunMove { state: RunState::Queued, station: None, reason: None, at: run.now };
    announce(out, &run.id, run.routine_id, &queued);
    Ok(())
}

pub(crate) fn announce(out: &mut Outbox, run_id: &str, routine_id: &str, change: &RunMove) {
    let payload = RunChange {
        run_id: run_id.to_owned(),
        routine_id: routine_id.to_owned(),
        state: change.state.as_str().to_owned(),
        station: change.station.map(|station| station.as_str().to_owned()),
        reason: change.reason.map(|reason| reason.as_str().to_owned()),
        needs_user: None,
    };
    out.push(RUN_CHANGE.name(), &payload);
}

/// Announces that a run which did not move began or stopped waiting on the
/// user, and what `runs:active` says after it.
pub(crate) fn announce_waiting(tx: &dyn Tx, out: &mut Outbox, run: &StoredRun, needs_user: bool) -> Result<(), Error> {
    let payload = RunChange {
        run_id: run.id.clone(),
        routine_id: run.routine_id.clone(),
        state: run.state.as_str().to_owned(),
        station: run.station.map(|station| station.as_str().to_owned()),
        reason: run.reason.map(|reason| reason.as_str().to_owned()),
        needs_user: Some(needs_user),
    };
    out.push(RUN_CHANGE.name(), &payload);
    let (count, needs_user) = tx.runs().active()?;
    out.push(RUNS_ACTIVE.name(), &RunsActive { count, needs_user });
    Ok(())
}

/// The engine as the port the other areas start runs through.
pub(crate) struct Runs(pub(crate) Arc<Engine>);

impl eos_core::routine::RunStarter for Runs {
    fn start(
        &self,
        run: eos_core::routine::NewRun,
    ) -> eos_core::BoxFuture<'_, Result<Vec<RunCreated>, eos_core::routine::StartError>> {
        Box::pin(start::start(&self.0, run))
    }

    fn stop<'a>(
        &'a self,
        run_id: &'a str,
        why: eos_domain::routine::run::Reason,
    ) -> eos_core::BoxFuture<'a, Result<(), Error>> {
        Box::pin(cancel::stop(&self.0, run_id, why))
    }
}

pub(crate) fn start_supervisor(engine: &Arc<Engine>) {
    supervisor::spawn(engine);
}

/// From now on, a run that ends (done, failed, cancelled, skipped) has its
/// sessions interrupted and suspended, after the write that ended it, a
/// trial run tells the routine's architect how it went, and memory hears
/// how it ended. The chat a run was started from hears of it too.
pub(crate) fn end_sessions_of_ended_runs(engine: &Arc<Engine>) {
    let weak = Arc::downgrade(engine);
    let subscription = engine.bus.on(RUN_CHANGE.name(), move |event| {
        let Some(engine) = weak.upgrade() else { return };
        let Ok(change) = event.payload_as::<RunChange>() else { return };
        crate::chat::tell_chats(&engine, &change);
        if !matches!(change.state.as_str(), "done" | "failed" | "cancelled" | "skipped") {
            return;
        }
        let Some(tasks) = engine.tasks.clone() else { return };
        tasks.spawn(async move {
            steer::quiet(&engine, &change.run_id).await;
            crate::architect::trial_ended(&engine, &change.run_id).await;
            memory::run_ended(&engine, &change).await;
        });
    });
    *Engine::locked(&engine.ended) = Some(subscription);
}

/// Ends the supervisor and waits until it let go of the engine, so the store
/// is free once the app shuts down.
pub(crate) async fn stop_supervisor(engine: &Engine) {
    drop(Engine::locked(&engine.ended).take());
    drop(Engine::locked(&engine.halt).take());
    drop(Engine::locked(&engine.handoffs).take());
    drop(Engine::locked(&engine.usage).take());
    let task = Engine::locked(&engine.supervisor).take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
    // After the supervisor: a turn of it still running could start a pass.
    crate::retention::stop(engine).await;
    crate::suggest::stop(engine).await;
}
