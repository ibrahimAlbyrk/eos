//! The goal loop (`config.loop`): an orchestrator gives a worker a goal with
//! criteria, and at each of the worker's idle edges a check decides whether
//! they are met. Until then the worker's report is held and the worker is
//! sent what is still unmet, within the attempt limit and while it makes
//! progress (`manager/services/GoalLoopService.ts`, `loop-rearm.ts`,
//! `core/src/use-cases/runLoopTick.ts`).
//!
//! | Module | |
//! |---|---|
//! | `routes` | `POST /orchestrators/{id}/loop` (attach, amend), `/loop/stop` |
//! | `tick` | the goal gate at an idle edge |
//! | `check` | the command, judge and hybrid checks, and the judge's evidence |
//! | `commands` | the verify commands |
//!
//! A worker's report is held by the session service (`eos_sessions::report`)
//! while its loop is active; this crate releases it.

mod check;
mod commands;
mod routes;
mod tick;

pub use commands::{CommandResult, ShellCommands, VerifyCommands};

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::LoopStatus;
use eos_contracts::stream::topics::{LOOP_CHANGE, WORKER_EXIT};
use eos_core::agent::OneShot;
use eos_core::git::GitDiffs;
use eos_core::store::{ConfigSource, Store};
use eos_core::{BoxFuture, Ids};
use eos_prompts::PromptService;
use eos_runtime::bus::{Bus, Subscription};
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use eos_sessions::Sessions;
use serde_json::{Value, json};
use tokio::task::JoinSet;

use crate::check::Checker;
use crate::tick::Engine;

/// Where the goal loop runs among the idle hooks: after compaction, before
/// the report and context nudges.
const IDLE_ORDER: i32 = 20;

/// What the loop is built from.
pub struct Parts {
    pub store: Arc<dyn Store>,
    pub sessions: Sessions,
    pub config: Arc<dyn ConfigSource>,
    pub prompts: Arc<PromptService>,
    /// The judge: the model asked once per check.
    pub judge: Arc<dyn OneShot>,
    pub diffs: Arc<dyn GitDiffs>,
    pub commands: Arc<dyn VerifyCommands>,
    pub ids: Arc<dyn Ids>,
    pub bus: Bus,
}

pub struct LoopsModule {
    engine: Arc<Engine>,
    deps: routes::Deps,
    bus: Bus,
    /// Continue the active loops' workers at start-up. Only an app on the
    /// user's own data folder does: it starts agents.
    rearms: bool,
    /// The ticks running in the background.
    ticks: Arc<Mutex<JoinSet<()>>>,
    listening: Mutex<Vec<Subscription>>,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for LoopsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopsModule").field("rearms", &self.rearms).finish_non_exhaustive()
    }
}

impl LoopsModule {
    pub fn new(parts: Parts) -> Self {
        let judge_model = parts.config.current().r#loop.judge.model.clone();
        let checker =
            Checker { diffs: parts.diffs.clone(), judge: parts.judge, prompts: parts.prompts.clone(), judge_model };
        let deps = routes::Deps {
            store: parts.store.clone(),
            config: parts.config.clone(),
            ids: parts.ids,
            clock: parts.sessions.clock().clone(),
        };
        let engine = Engine::new(
            parts.store,
            parts.sessions,
            parts.config,
            parts.prompts,
            parts.diffs,
            parts.commands,
            checker,
            parts.bus.clone(),
        );
        Self {
            engine: Arc::new(engine),
            deps,
            bus: parts.bus,
            rearms: false,
            ticks: Arc::default(),
            listening: Mutex::default(),
        }
    }

    /// Continues the active loops' workers when the app is ready.
    pub fn rearming(mut self, on: bool) -> Self {
        self.rearms = on;
        self
    }

    /// Checks the worker's goal in the background, as an idle edge does.
    pub fn tick(&self, worker_id: &str) {
        spawn_tick(&self.engine, &self.ticks, worker_id);
    }

    /// Checks the worker's goal now and returns once the tick is done.
    pub async fn check(&self, worker_id: &str) -> Result<(), eos_core::Error> {
        self.engine.tick_for(worker_id).await.map(drop)
    }
}

fn spawn_tick(engine: &Arc<Engine>, ticks: &Arc<Mutex<JoinSet<()>>>, worker_id: &str) {
    let (engine, id) = (engine.clone(), worker_id.to_owned());
    let mut running = ticks.lock().unwrap_or_else(PoisonError::into_inner);
    // Ended ticks are let go of here, so the set holds only running ones.
    while running.try_join_next().is_some() {}
    running.spawn(async move {
        if let Err(e) = engine.tick_for(&id).await {
            tracing::warn!(worker_id = id, error = %e, "a loop's tick failed");
        }
    });
}

/// A worker whose session is over cannot work toward its goal: its loop stops.
async fn stop_for_exited(store: &dyn Store, now: i64, worker_id: String) -> Result<(), eos_core::Error> {
    store
        .write(move |tx, out| {
            let Some(active) = tx.loops().find_active_by_worker(&worker_id)? else { return Ok(()) };
            tx.loops().set_status(&active.id, LoopStatus::Stopped, now)?;
            out.push(LOOP_CHANGE, &json!({"workerId": worker_id, "status": "stopped"}));
            Ok(())
        })
        .await
}

impl Module for LoopsModule {
    fn id(&self) -> &'static str {
        "loops"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.deps)
    }

    fn idle_hooks(&self) -> Vec<IdleHook> {
        let (engine, ticks) = (self.engine.clone(), self.ticks.clone());
        // The check runs on its own (it may take minutes): the hooks after it still run.
        vec![IdleHook::new("goal-loop", IDLE_ORDER, move |worker_id| {
            spawn_tick(&engine, &ticks, worker_id);
            async { false }
        })]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            let (store, clock, tasks) =
                (self.deps.store.clone(), self.deps.clock.clone(), tokio::runtime::Handle::current());
            let stops = self.bus.on(WORKER_EXIT, move |event| {
                let gone = event.payload_as::<Value>().ok().and_then(|p| p["workerId"].as_str().map(str::to_owned));
                let Some(id) = gone else { return };
                let (store, now) = (store.clone(), clock.now_ms());
                tasks.spawn(async move {
                    if let Err(e) = stop_for_exited(store.as_ref(), now, id).await {
                        tracing::warn!(error = %e, "an exited worker's loop could not be stopped");
                    }
                });
            });
            self.listening.lock().unwrap_or_else(PoisonError::into_inner).push(stops);
            Ok(())
        })
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            if !self.rearms {
                return Ok(());
            }
            // A loop has no clock of its own: after a restart its worker is continued, and its
            // next idle edge checks the goal (the held report survived in the database).
            let active = self.deps.store.read(|tx| tx.loops().list_active()).await;
            for found in active.unwrap_or_default() {
                let id = found.worker_id.clone();
                let worker = self.deps.store.read(move |tx| tx.workers().find(&id)).await.ok().flatten();
                let Some(worker) = worker else { continue };
                if let Err(e) = self.engine.sessions.revive(&worker.id).await {
                    tracing::warn!(worker_id = worker.id, error = %e, "a loop's worker could not be continued");
                    continue;
                }
                self.tick(&worker.id);
            }
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.listening.lock().unwrap_or_else(PoisonError::into_inner).clear();
            self.ticks.lock().unwrap_or_else(PoisonError::into_inner).abort_all();
        })
    }
}
