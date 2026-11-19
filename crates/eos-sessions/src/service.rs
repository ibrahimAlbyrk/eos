//! The session service: what features hold to start agents, talk to them
//! and end them, and where every session's events land.

use std::cell::Cell;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use eos_contracts::stream::topics::WORKER_EXIT;
use eos_contracts::{
    AgentEvent, AgentMessageEventRole, DeltaEvent, DeltaEventPhase, SessionEventOutcome, SessionEventPhase,
    TurnEventPhase, WorkerEventType, WorkerState, WorkflowRunProgress,
};
use eos_core::agent::{
    AgentRuntime, AgentSession, BackendDescriptor, BackgroundTaskUpdate, CompactionNotice, LaunchSpec, ModelCatalog,
    PromptAssembler, SessionSink, ToolInputDelta,
};
use eos_core::git::WorktreeManager;
use eos_core::store::{ConfigSource, RecentFolders, Store};
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_domain::Worker;
use serde::Serialize;

use crate::commands::{Clear, SlashCommand};
use crate::peers::PeerRequests;
use crate::reactions::Reactions;
use crate::signal::{self, SignalCx};
use crate::starts::Starts;
use crate::transition::transition_state;
use crate::turns::Turns;

/// What the running app adds around sessions: live text on the bus, the
/// features that listen to agents, what runs when a worker goes idle. The app
/// implements it over its modules; tests use [`NoHooks`].
pub trait SessionHooks: Send + Sync + 'static {
    /// One piece of live text. Never logged.
    fn delta(&self, _worker_id: &str, _delta: &DeltaEvent) {}
    /// The worker's session is over (its exit was recorded).
    fn exited(&self, _worker_id: &str) {}
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
    /// A session's summary of its conversation started, finished or failed
    /// (its row is recorded).
    fn compaction(&self, _worker_id: &str, _notice: &CompactionNotice) {}
    /// A worker was archived: its session is over, its data stays.
    fn archived(&self, _worker: &Worker) {}
    /// A worker's row is gone for good (its scratch folder, its browser, … go too).
    fn removed(&self, _worker: &Worker) {}
    /// Whether a worker's folder still exists.
    fn folder_exists(&self, _path: &str) -> bool {
        true
    }
    /// The last word on how a session starts, right before it does, at a
    /// spawn and at every resume: what a feature keeps of a worker that its
    /// row does not hold.
    fn shape_launch(&self, _spec: &mut LaunchSpec) {}
}

/// The pauses before each new try of a batch of events the database did not take
/// (busy, or the write failed), in ms: about 4 s in all, then the batch is given up.
const RECORD_RETRY_MS: [i64; 6] = [50, 100, 250, 500, 1_000, 2_000];

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
    /// Waits (a peer that may still join, an idle chat's session).
    pub sleeper: Arc<dyn Sleeper>,
}

impl std::fmt::Debug for SessionDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionDeps").finish_non_exhaustive()
    }
}

/// How far a try of [`Sessions::record`]'s write got.
#[derive(Default)]
enum Stage {
    /// It never ran.
    #[default]
    Waiting,
    /// It began and never returned: it panicked.
    Running,
    /// It ran to the end; what failed came after (the commit).
    Done,
    /// It failed itself.
    Failed,
}

#[derive(Default)]
struct Tried {
    stage: Stage,
    marked: Option<(crate::turns::Marked, crate::turns::Marked)>,
}

/// Work done for one worker at a time. A caller that finds the worker taken
/// leaves a mark, so whoever holds it looks again when done: an idle edge
/// that arrives mid-work is never lost.
#[derive(Default)]
pub(crate) struct Claims(Mutex<Vec<(String, bool)>>);

/// A worker taken through [`Claims::claim`]. Given back by
/// [`release`](Claim::release), or when dropped: a holder that never finished
/// (its task was ended) does not keep the worker taken.
pub(crate) struct Claim<'a> {
    claims: &'a Claims,
    worker_id: &'a str,
    held: bool,
}

impl Claims {
    /// Takes `worker_id`; `None` when it is taken (the holder is told to look again).
    pub(crate) fn claim<'a>(&'a self, worker_id: &'a str) -> Option<Claim<'a>> {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match held.iter_mut().find(|(id, _)| id == worker_id) {
            Some(taken) => {
                taken.1 = true;
                None
            }
            None => {
                held.push((worker_id.to_owned(), false));
                Some(Claim { claims: self, worker_id, held: true })
            }
        }
    }

    /// Gives `worker_id` back; `true` when someone came by meanwhile.
    fn give_back(&self, worker_id: &str) -> bool {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let at = held.iter().position(|(id, _)| id == worker_id);
        at.is_some_and(|at| held.remove(at).1)
    }
}

impl Claim<'_> {
    /// Gives the worker back; `true` when someone came by meanwhile.
    pub(crate) fn release(mut self) -> bool {
        self.held = false;
        self.claims.give_back(self.worker_id)
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if self.held {
            self.claims.give_back(self.worker_id);
        }
    }
}

pub(crate) struct Inner {
    pub(crate) deps: SessionDeps,
    pub(crate) turns: Turns,
    /// Workers whose queue is being drained right now.
    draining: Claims,
    /// Workers being suspended or removed on purpose: their session's exit is expected.
    pub(crate) leaving: Mutex<HashSet<String>>,
    /// The commands Eos runs itself, `/clear` first. Held weakly: a
    /// feature's command holds the feature, which holds this service; the
    /// app keeps each one for as long as it runs, and `_clear` keeps `/clear`.
    pub(crate) commands: std::sync::RwLock<Vec<Weak<dyn SlashCommand>>>,
    _clear: Arc<dyn SlashCommand>,
    /// What workers ask each other.
    pub(crate) peers: PeerRequests,
    /// Workers whose session is being started, and who waits for it.
    pub(crate) starts: Starts,
    /// The user's reactions that wait for their turn.
    pub(crate) reactions: Reactions,
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
        let clear: Arc<dyn SlashCommand> = Arc::new(Clear);
        let commands = std::sync::RwLock::new(vec![Arc::downgrade(&clear)]);
        let peers = PeerRequests::new(deps.clock.clone(), deps.ids.clone());
        let inner = Inner {
            deps,
            turns,
            draining: Claims::default(),
            leaving: Mutex::default(),
            commands,
            _clear: clear,
            peers,
            starts: Starts::default(),
            reactions: Reactions::default(),
        };
        Self(Arc::new(inner))
    }

    /// Adds a command a feature owns (`/compact`, …), for as long as the
    /// caller keeps it. A later one of the same name replaces the earlier.
    pub fn register_command(&self, command: &Arc<dyn SlashCommand>) {
        let mut commands = self.0.commands.write().unwrap_or_else(PoisonError::into_inner);
        commands.retain(|held| held.upgrade().is_some_and(|c| c.name() != command.name()));
        commands.push(Arc::downgrade(command));
    }

    /// The commands Eos runs itself, for the composer's menu.
    pub fn commands(&self) -> Vec<Arc<dyn SlashCommand>> {
        self.0.commands.read().unwrap_or_else(PoisonError::into_inner).iter().filter_map(Weak::upgrade).collect()
    }

    pub(crate) fn command(&self, name: &str) -> Option<Arc<dyn SlashCommand>> {
        self.commands().into_iter().find(|c| c.name() == name || c.aliases().contains(&name))
    }

    /// Where the runtime reports the sessions this service starts.
    pub(crate) fn sink(&self) -> Arc<dyn SessionSink> {
        Arc::new(self.clone())
    }

    pub fn store(&self) -> &Arc<dyn Store> {
        &self.0.deps.store
    }

    pub(crate) fn now(&self) -> i64 {
        self.0.deps.clock.now_ms()
    }

    /// The clock the service stamps rows with.
    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.0.deps.clock
    }

    /// What the engine behind every session is and can do.
    pub fn descriptor(&self) -> &BackendDescriptor {
        self.0.deps.runtime.descriptor()
    }

    /// The worker's live session, if it has one.
    pub fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.0.deps.runtime.session(worker_id).filter(|s| s.is_alive())
    }

    pub fn is_live(&self, worker_id: &str) -> bool {
        self.session(worker_id).is_some()
    }

    /// How many subagents and workflow agents of the worker's own session are running.
    pub fn live_subagents(&self, worker_id: &str) -> usize {
        self.session(worker_id).map_or(0, |session| session.live_subagents())
    }

    /// A feature holds the worker (it is being summarized): messages to it wait.
    pub fn is_held(&self, worker_id: &str) -> bool {
        self.0.deps.hooks.holds_worker(worker_id)
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
    /// A write that never ran (a full queue, a transaction that could not start) or ran
    /// but was not saved (its commit failed) is tried again after a pause
    /// ([`RECORD_RETRY_MS`]): the batch may hold the turn's end, without which the worker
    /// stays WORKING. One that failed itself (bad data, a panic) would fail the same way.
    async fn record(&self, worker_id: &str, events: Vec<AgentEvent>) -> bool {
        if events.is_empty() {
            return false;
        }
        let events = Arc::new(events);
        let mut pauses = RECORD_RETRY_MS.iter();
        loop {
            let tried: Arc<Mutex<Tried>> = Arc::default();
            let (inner, id, batch, seen) = (self.0.clone(), worker_id.to_owned(), events.clone(), tried.clone());
            let written = self
                .store()
                .write(move |tx, out| {
                    let note =
                        |stage, marked| *seen.lock().unwrap_or_else(PoisonError::into_inner) = Tried { stage, marked };
                    note(Stage::Running, None);
                    // A worker removed meanwhile leaves no rows behind.
                    let Some(row) = tx.workers().find(&id).inspect_err(|_| note(Stage::Failed, None))? else {
                        note(Stage::Done, None);
                        return Ok(false);
                    };
                    let config = inner.deps.config.current();
                    let cx = SignalCx {
                        now: inner.deps.clock.now_ms(),
                        turns: &inner.turns,
                        config: &config,
                        state: Cell::new(row.state),
                        model: row.model,
                        marked: Cell::new(None),
                    };
                    let mut idle = Ok(false);
                    for event in batch.iter() {
                        idle = match signal::apply(tx, out, &cx, &id, event) {
                            Ok(applied) => idle.map(|idle| idle | applied.idle),
                            Err(e) => Err(e),
                        };
                        if idle.is_err() {
                            break;
                        }
                    }
                    note(if idle.is_ok() { Stage::Done } else { Stage::Failed }, cx.marked.get());
                    idle
                })
                .await;
            let error = match written {
                Ok(idle) => return idle,
                Err(e) => e,
            };
            let tried = std::mem::take(&mut *tried.lock().unwrap_or_else(PoisonError::into_inner));
            let transient = matches!(tried.stage, Stage::Waiting | Stage::Done)
                && matches!(error, Error::LimitExceeded(_) | Error::Storage(_));
            let Some(&pause) = pauses.next().filter(|_| transient) else {
                tracing::error!(worker_id, error = %error, "an agent's events could not be recorded");
                return false;
            };
            if pause == RECORD_RETRY_MS[0] {
                tracing::warn!(worker_id, error = %error, "an agent's events wait for the database");
            }
            // Nothing of the try was saved: the next one starts from the turn as it was.
            if let Some((first, last)) = tried.marked {
                self.0.turns.unmark(worker_id, first, last);
            }
            self.0.deps.sleeper.sleep(pause).await;
        }
    }

    async fn on_events(&self, worker_id: &str, events: Vec<AgentEvent>) {
        let hooks = &self.0.deps.hooks;
        let mut durable = Vec::new();
        let mut idle = false;
        let mut events = events.into_iter().peekable();
        while let Some(event) = events.next() {
            self.log_lifecycle(worker_id, &event);
            match event {
                // Live text is relayed, never recorded; what was recorded
                // before it goes out first, so rows and text keep their order.
                AgentEvent::Delta(mut delta) => {
                    // The block's pieces that follow it in this batch go out with it.
                    while delta.phase != DeltaEventPhase::Stop
                        && let Some(AgentEvent::Delta(next)) = events.peek()
                        && continues(&delta, next)
                    {
                        delta.text.push_str(&next.text);
                        events.next();
                    }
                    idle |= self.record(worker_id, std::mem::take(&mut durable)).await;
                    self.0.turns.mark_seen(worker_id);
                    hooks.delta(worker_id, &delta);
                }
                event => {
                    if let AgentEvent::Message(m) = &event
                        && m.role == AgentMessageEventRole::Assistant
                    {
                        self.0.turns.mark_seen(worker_id);
                    }
                    hooks.agent_event(worker_id, &event);
                    durable.push(event);
                }
            }
        }
        idle |= self.record(worker_id, durable).await;
        if idle {
            self.settled(worker_id).await;
        }
    }

    /// A session's lifecycle in the log, by id: never what was said in it.
    fn log_lifecycle(&self, worker_id: &str, event: &AgentEvent) {
        match event {
            AgentEvent::Turn(turn) => {
                let reason = turn.reason.as_deref().unwrap_or("-");
                match turn.phase {
                    TurnEventPhase::Started => {
                        self.0.turns.mark_started(worker_id);
                        tracing::info!(worker_id, "turn started");
                    }
                    TurnEventPhase::Ended | TurnEventPhase::Aborted => {
                        let ms = self.0.turns.take_duration(worker_id);
                        let outcome = if turn.phase == TurnEventPhase::Ended { "ended" } else { "aborted" };
                        tracing::info!(worker_id, outcome, reason, ms, "turn ended");
                    }
                    TurnEventPhase::Error => {
                        let ms = self.0.turns.take_duration(worker_id);
                        tracing::warn!(worker_id, outcome = "error", reason, ms, "turn ended");
                    }
                }
            }
            AgentEvent::Session(session) => {
                let phase = match session.phase {
                    SessionEventPhase::Started => "started",
                    SessionEventPhase::Ready => "ready",
                    SessionEventPhase::Ended => "ended",
                    SessionEventPhase::Cleared => "cleared",
                };
                let outcome = session.outcome.map(|o| match o {
                    SessionEventOutcome::Success => "success",
                    SessionEventOutcome::Killed => "killed",
                    SessionEventOutcome::Crashed => "crashed",
                });
                if outcome == Some("crashed") {
                    tracing::warn!(worker_id, phase, outcome, "session crashed");
                } else {
                    tracing::info!(worker_id, phase, outcome, "session {phase}");
                }
            }
            _ => {}
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
        tracing::info!(worker_id, ?code, expected, "session exited");
        self.0.turns.forget(worker_id);
        self.0.reactions.forget(worker_id);
        self.0.deps.hooks.exited(worker_id);
        // Whoever waits on its answer hears that it is gone.
        self.0.peers.cancel_by_worker(worker_id);
    }

    /// The worker reached IDLE: its queue gets its turn, then the user's
    /// reactions that are due one, and when neither starts a turn, whatever
    /// runs at a worker's idle edge.
    pub(crate) fn settled<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // A peer's question starts a turn of its own; the queue waits for the next idle edge.
            if self.pump_peer(worker_id).await {
                return;
            }
            // A turn that ends while its queue is being drained settles again afterwards.
            let Some(claim) = self.0.draining.claim(worker_id) else { return };
            let outcome = self.drain(worker_id).await;
            if claim.release() {
                self.settled(worker_id).await;
            } else if outcome == crate::dispatch::Drained::Empty && !self.deliver_reactions(worker_id).await {
                self.0.deps.hooks.idle(worker_id);
            }
        })
    }
}

/// Whether `next` is more text of the same block on the same channel: the two
/// read as one piece.
fn continues(delta: &DeltaEvent, next: &DeltaEvent) -> bool {
    next.phase == DeltaEventPhase::Append && next.block_id == delta.block_id && next.channel == delta.channel
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

    fn compaction<'a>(&'a self, worker_id: &'a str, notice: CompactionNotice) -> BoxFuture<'a, ()> {
        Box::pin(self.on_compaction(worker_id, notice))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whoever_finds_a_worker_taken_makes_its_holder_look_again() {
        let claims = Claims::default();
        let one = claims.claim("w-1").expect("free");
        let two = claims.claim("w-2").expect("workers do not wait on each other");
        assert!(claims.claim("w-1").is_none() && claims.claim("w-1").is_none());
        assert!(one.release(), "someone came by");
        assert!(!two.release());
        let again = claims.claim("w-1").expect("free again");
        assert!(!again.release(), "the mark went with the release before");
        assert!(!claims.give_back("w-1"), "nothing is kept of a worker that is not held");
    }

    #[test]
    fn a_holder_that_never_finishes_does_not_keep_the_worker() {
        let claims = Claims::default();
        let held = claims.claim("w-1").expect("free");
        assert!(claims.claim("w-1").is_none());
        // Its task was ended mid-work (a session's pump aborted at a stop timeout).
        drop(held);
        assert!(claims.claim("w-1").is_some(), "the next idle edge takes it");
    }
}
