//! The session service: what features hold to start agents, talk to them
//! and end them, and where every session's events land.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::stream::topics::WORKER_EXIT;
use eos_contracts::{AgentEvent, AgentMessageEventRole, DeltaEvent, WorkerEventType, WorkerState, WorkflowRunProgress};
use eos_core::agent::{
    AgentRuntime, AgentSession, BackgroundTaskUpdate, ModelCatalog, PromptAssembler, SessionSink, ToolInputDelta,
};
use eos_core::git::WorktreeManager;
use eos_core::store::{ConfigSource, RecentFolders, Store};
use eos_core::{BoxFuture, Clock, Ids};
use eos_domain::Worker;
use serde::Serialize;

use crate::signal::{self, SignalCx};
use crate::transition::transition_state;
use crate::turns::Turns;

/// What the running app adds around sessions: live text on the bus, the
/// features that listen to agents, what runs when a worker goes idle. The app
/// implements it over its modules; tests use [`NoHooks`].
pub trait SessionHooks: Send + Sync + 'static {
    /// One piece of live text. Never logged.
    fn delta(&self, _worker_id: &str, _delta: &DeltaEvent) {}
    /// Every other event of a session, before it is recorded.
    fn agent_event(&self, _worker_id: &str, _event: &AgentEvent) {}
    /// True while a feature holds the worker: every message to it queues.
    fn holds_worker(&self, _worker_id: &str) -> bool {
        false
    }
    /// The worker settled at IDLE with nothing left in its queue.
    fn idle(&self, _worker_id: &str) {}
    fn follows_tool_input(&self, _tool: &str) -> bool {
        false
    }
    fn tool_input(&self, _worker_id: &str, _delta: ToolInputDelta) {}
    fn workflow_progress(&self, _progress: WorkflowRunProgress) {}
    fn background_task(&self, _worker_id: &str, _update: BackgroundTaskUpdate) {}
    /// A worker's row is gone for good (its scratch folder, its browser, … go too).
    fn removed(&self, _worker: &Worker) {}
    /// Whether a worker's folder still exists.
    fn folder_exists(&self, _path: &str) -> bool {
        true
    }
}

/// Hooks that do nothing.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoHooks;

impl SessionHooks for NoHooks {}

/// What the service is built from.
#[derive(Clone)]
pub struct SessionDeps {
    pub store: Arc<dyn Store>,
    pub runtime: Arc<dyn AgentRuntime>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub config: Arc<dyn ConfigSource>,
    pub models: Arc<dyn ModelCatalog>,
    pub prompts: Arc<dyn PromptAssembler>,
    pub worktrees: Arc<dyn WorktreeManager>,
    pub recents: Arc<dyn RecentFolders>,
    pub hooks: Arc<dyn SessionHooks>,
}

impl std::fmt::Debug for SessionDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionDeps").finish_non_exhaustive()
    }
}

pub(crate) struct Inner {
    pub(crate) deps: SessionDeps,
    pub(crate) turns: Turns,
    /// Workers whose queue is being drained right now.
    draining: Mutex<HashSet<String>>,
    /// Workers being suspended or removed on purpose: their session's exit is expected.
    pub(crate) leaving: Mutex<HashSet<String>>,
}

/// The lifecycle of agent sessions. Cheap to clone.
#[derive(Clone)]
pub struct Sessions(pub(crate) Arc<Inner>);

impl std::fmt::Debug for Sessions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sessions").field("live", &self.0.deps.runtime.live()).finish_non_exhaustive()
    }
}

/// `worker:change` with nothing but the worker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Changed<'a> {
    pub(crate) worker_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) queued: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Exited<'a> {
    worker_id: &'a str,
    code: Option<i32>,
}

#[derive(Serialize)]
struct ExitRow {
    code: Option<i32>,
}

impl Sessions {
    pub fn new(deps: SessionDeps) -> Self {
        let turns = Turns::new(deps.clock.clone());
        Self(Arc::new(Inner { deps, turns, draining: Mutex::default(), leaving: Mutex::default() }))
    }

    /// Where the runtime reports the sessions this service starts.
    pub(crate) fn sink(&self) -> Arc<dyn SessionSink> {
        Arc::new(self.clone())
    }

    pub(crate) fn store(&self) -> &Arc<dyn Store> {
        &self.0.deps.store
    }

    pub(crate) fn now(&self) -> i64 {
        self.0.deps.clock.now_ms()
    }

    /// The clock the service stamps rows with.
    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.0.deps.clock
    }

    /// The worker's live session, if it has one.
    pub fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.0.deps.runtime.session(worker_id).filter(|s| s.is_alive())
    }

    pub fn is_live(&self, worker_id: &str) -> bool {
        self.session(worker_id).is_some()
    }

    /// How many workers have something remembered about their current turn.
    pub fn tracked_turns(&self) -> usize {
        self.0.turns.len()
    }

    pub(crate) fn leaving(&self, worker_id: &str, on: bool) {
        let mut leaving = self.0.leaving.lock().unwrap_or_else(PoisonError::into_inner);
        if on {
            leaving.insert(worker_id.to_owned());
        } else {
            leaving.remove(worker_id);
        }
    }

    /// Records a run of durable events in one write; says whether the worker went idle.
    async fn record(&self, worker_id: &str, events: Vec<AgentEvent>) -> bool {
        if events.is_empty() {
            return false;
        }
        let inner = self.0.clone();
        let id = worker_id.to_owned();
        let written = self
            .store()
            .write(move |tx, out| {
                // A worker removed meanwhile leaves no rows behind.
                if tx.workers().find(&id)?.is_none() {
                    return Ok(false);
                }
                let config = inner.deps.config.current();
                let cx = SignalCx { now: inner.deps.clock.now_ms(), turns: &inner.turns, config: &config };
                let mut idle = false;
                for event in events {
                    idle |= signal::apply(tx, out, &cx, &id, event)?.idle;
                }
                Ok(idle)
            })
            .await;
        match written {
            Ok(idle) => idle,
            Err(e) => {
                tracing::error!(worker_id, error = %e, "an agent's events could not be recorded");
                false
            }
        }
    }

    async fn on_events(&self, worker_id: &str, events: Vec<AgentEvent>) {
        let hooks = &self.0.deps.hooks;
        let mut durable = Vec::new();
        let mut idle = false;
        for event in events {
            match &event {
                // Live text is relayed, never recorded; what was recorded
                // before it goes out first, so rows and text keep their order.
                AgentEvent::Delta(delta) => {
                    idle |= self.record(worker_id, std::mem::take(&mut durable)).await;
                    self.0.turns.mark_seen(worker_id);
                    hooks.delta(worker_id, delta);
                    continue;
                }
                AgentEvent::Message(m) if m.role == AgentMessageEventRole::Assistant => {
                    self.0.turns.mark_seen(worker_id);
                }
                _ => {}
            }
            hooks.agent_event(worker_id, &event);
            durable.push(event);
        }
        idle |= self.record(worker_id, durable).await;
        if idle {
            self.settled(worker_id).await;
        }
    }

    /// A session's process is over (`recordSessionExit`): a conversation that
    /// can be continued parks its worker as SUSPENDED, anything else is DONE.
    /// An exit on purpose (a suspend, a removal) was already accounted for.
    async fn on_exit(&self, worker_id: &str, code: Option<i32>) {
        let expected = self.0.leaving.lock().unwrap_or_else(PoisonError::into_inner).contains(worker_id);
        let resumable = self.0.deps.runtime.descriptor().capabilities.resumable == Some(true);
        let now = self.now();
        let id = worker_id.to_owned();
        let written = self
            .store()
            .write(move |tx, out| {
                let Some(row) = tx.workers().find(&id)? else { return Ok(()) };
                if !expected {
                    let deliberate = matches!(row.state, WorkerState::Ending | WorkerState::Killing);
                    let has_session = row.session_id.as_deref().is_some_and(|s| !s.is_empty());
                    if resumable && has_session && !deliberate {
                        transition_state(tx, out, now, &id, WorkerState::Suspended, "session_exit")?;
                        tx.workers().clear_runtime(&id)?;
                    } else {
                        tx.workers().mark_done(&id, now, code.map(i64::from))?;
                    }
                }
                tx.events().append_json(&id, now, WorkerEventType::Exit, &ExitRow { code })?;
                out.push(WORKER_EXIT, &Exited { worker_id: &id, code });
                Ok(())
            })
            .await;
        if let Err(e) = written {
            tracing::error!(worker_id, error = %e, "a session's exit could not be recorded");
        }
        self.0.turns.forget(worker_id);
    }

    /// The worker reached IDLE: its queue gets its turn, and when that is
    /// empty, whatever runs at a worker's idle edge.
    pub(crate) fn settled<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            {
                let mut draining = self.0.draining.lock().unwrap_or_else(PoisonError::into_inner);
                if !draining.insert(worker_id.to_owned()) {
                    return;
                }
            }
            let outcome = self.drain(worker_id).await;
            self.0.draining.lock().unwrap_or_else(PoisonError::into_inner).remove(worker_id);
            if outcome == crate::dispatch::Drained::Empty {
                self.0.deps.hooks.idle(worker_id);
            }
        })
    }
}

impl SessionSink for Sessions {
    fn events<'a>(&'a self, worker_id: &'a str, events: Vec<AgentEvent>) -> BoxFuture<'a, ()> {
        Box::pin(self.on_events(worker_id, events))
    }

    fn exited<'a>(&'a self, worker_id: &'a str, code: Option<i32>) -> BoxFuture<'a, ()> {
        Box::pin(self.on_exit(worker_id, code))
    }

    fn follows_tool_input(&self, tool: &str) -> bool {
        self.0.deps.hooks.follows_tool_input(tool)
    }

    fn tool_input(&self, worker_id: &str, delta: ToolInputDelta) {
        self.0.deps.hooks.tool_input(worker_id, delta);
    }

    fn workflow_progress(&self, progress: WorkflowRunProgress) {
        self.0.deps.hooks.workflow_progress(progress);
    }

    fn background_task(&self, worker_id: &str, update: BackgroundTaskUpdate) {
        self.0.deps.hooks.background_task(worker_id, update);
    }
}
