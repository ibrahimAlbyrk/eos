//! One live session: the engine's agent, and the pump that turns what it
//! reports into canonical events for the sink.
//!
//! The engine runs the agent as a task of its own. Eos adds one task per
//! session, the pump: it reads the agent's three event channels (its own
//! events, its subagents', its background tasks'), drives the turns it was
//! asked to run, and hands the mapped events to the sink in batches, waiting
//! for the sink each time. Nothing else touches the mapper, so the events of
//! a session are in one order.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use eos_agent_core::{AgentEvent as EngineEvent, ModelError, TaskEvent, TurnError};
use eos_agent_sdk::{InputError, SdkAgent, SkillOrigin, SubagentEvent, SubagentEventKind};
use eos_contracts::{
    AgentEvent, CommandItem, CommandItemSource, RewindMode, RewindTarget, SessionEvent, SessionEventOutcome,
    SessionEventPhase,
};
use eos_core::BoxFuture;
use eos_core::Clock;
use eos_core::accounts::{SessionCredential, SessionCredentials};
use eos_core::agent::{AgentCapabilities, AgentSession, Rewound, SessionError, SessionSink, SessionTranscript};
use futures_util::FutureExt;
use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{mpsc, oneshot};

use crate::accounts::{Accounts, NOT_SIGNED_IN, limits};
use crate::mapper::{Mapper, Side};
use crate::registry::Registry;
use crate::transcript;

/// How many engine events are mapped into one batch for the sink.
const BATCH: usize = 64;

/// What a session shares with the runtime that started it.
pub(crate) struct Shared {
    pub(crate) sessions: Arc<Registry>,
    pub(crate) accounts: Arc<Accounts>,
    pub(crate) credentials: Arc<dyn SessionCredentials>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) capabilities: AgentCapabilities,
    /// Where the engine keeps a session's recorded conversation.
    pub(crate) transcript_path: Box<dyn Fn(&str) -> String + Send + Sync>,
}

enum Command {
    Turn(String),
    /// Run the turn the conversation stopped in again, with no new input.
    Rerun,
    Stop(oneshot::Sender<()>),
}

/// How a turn the pump drove came out, when it has no event of its own.
enum TurnDone {
    /// It ran to an end the agent reported itself.
    Reported,
    /// It failed; `notice` is what the user reads, `plan` whether the
    /// session's credential was the reason.
    Failed { notice: String, plan: bool },
    /// It could not start: `notice` says why and what to do, and is all the
    /// turn shows (no credential: the form of Claude Code's own "Not logged in").
    Declined { notice: &'static str },
    /// The agent is gone.
    Gone,
}

/// What an agent with no credential at all answers, in the form of Claude
/// Code's "Not logged in · Please run /login", pointing where Eos signs in.
const SIGN_IN_NOTICE: &str = "Not signed in · Sign in to Claude under Settings › Accounts";

pub(crate) struct EngineSession {
    worker_id: String,
    pub(crate) focused: bool,
    shared: Arc<Shared>,
    /// `None` once the session is stopped: the engine's agent ends when the
    /// last holder lets go.
    agent: Mutex<Option<Arc<SdkAgent>>>,
    commands: mpsc::Sender<Command>,
    alive: AtomicBool,
    /// Background subagents and workflow runs the mapper has open.
    live: AtomicUsize,
    credential: Mutex<Option<SessionCredential>>,
    /// The accounts feature told the user why the next failure happens.
    silenced: AtomicBool,
}

fn failed(error: impl std::fmt::Display) -> SessionError {
    SessionError::Failed(error.to_string())
}

impl EngineSession {
    pub(crate) fn id(&self) -> &str {
        &self.worker_id
    }

    fn agent(&self) -> Result<Arc<SdkAgent>, SessionError> {
        self.agent.lock().unwrap_or_else(PoisonError::into_inner).clone().ok_or(SessionError::Gone)
    }

    pub(crate) fn set_credential(&self, credential: Option<SessionCredential>) {
        *self.credential.lock().unwrap_or_else(PoisonError::into_inner) = credential;
    }

    fn credential(&self) -> Option<SessionCredential> {
        self.credential.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub(crate) fn silence_next_failure(&self) {
        self.silenced.store(true, Ordering::SeqCst);
    }

    /// Lets go of the engine's agent and leaves the registry. Idempotent.
    fn close(&self) -> bool {
        let was_alive = self.alive.swap(false, Ordering::SeqCst);
        self.agent.lock().unwrap_or_else(PoisonError::into_inner).take();
        self.shared.sessions.remove(self);
        if was_alive {
            self.shared.credentials.launched(&self.worker_id, None);
        }
        was_alive
    }

    async fn command(&self, command: Command) -> Result<(), SessionError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(SessionError::Gone);
        }
        self.commands.send(command).await.map_err(|_| SessionError::Gone)
    }

    async fn prompts(&self) -> Result<(Arc<SdkAgent>, Vec<transcript::Prompt>), SessionError> {
        let agent = self.agent()?;
        let messages = agent.transcript().await.map_err(failed)?;
        Ok((agent, transcript::prompts(&messages)))
    }
}

/// Everything the pump needs; consumed by [`start`].
pub(crate) struct Launch {
    pub(crate) worker_id: String,
    pub(crate) focused: bool,
    pub(crate) agent: SdkAgent,
    pub(crate) events: mpsc::Receiver<EngineEvent>,
    pub(crate) subagents: mpsc::Receiver<SubagentEvent>,
    pub(crate) tasks: mpsc::Receiver<TaskEvent>,
    pub(crate) credential: Option<SessionCredential>,
    pub(crate) sink: Arc<dyn SessionSink>,
    pub(crate) shared: Arc<Shared>,
}

/// Registers the session and starts its pump. `None` when the worker
/// already has a live session.
pub(crate) fn start(launch: Launch) -> Option<Arc<EngineSession>> {
    let Launch { worker_id, focused, agent, events, subagents, tasks, credential, sink, shared } = launch;
    let (commands, inbox) = mpsc::channel(16);
    let agent = Arc::new(agent);
    let session = Arc::new(EngineSession {
        worker_id: worker_id.clone(),
        focused,
        shared: shared.clone(),
        agent: Mutex::new(Some(agent.clone())),
        commands,
        alive: AtomicBool::new(true),
        live: AtomicUsize::new(0),
        credential: Mutex::new(credential),
        silenced: AtomicBool::new(false),
    });
    if !shared.sessions.insert(session.clone()) {
        return None;
    }
    // Block ids must not repeat across launches of one worker: the time of
    // this launch tells them apart.
    let launch_tag = format!("e{:x}", shared.clock.now_ms());
    let pump = Pump {
        session: session.clone(),
        agent,
        events,
        subagents,
        tasks,
        inbox,
        turns: FuturesUnordered::new(),
        mapper: Mapper::new(launch_tag),
        sink,
    };
    tokio::spawn(pump.guarded());
    Some(session)
}

struct Pump {
    session: Arc<EngineSession>,
    agent: Arc<SdkAgent>,
    events: mpsc::Receiver<EngineEvent>,
    subagents: mpsc::Receiver<SubagentEvent>,
    tasks: mpsc::Receiver<TaskEvent>,
    inbox: mpsc::Receiver<Command>,
    turns: FuturesUnordered<BoxFuture<'static, TurnDone>>,
    mapper: Mapper,
    sink: Arc<dyn SessionSink>,
}

/// Why the pump stopped.
enum End {
    /// `stop` was called; the caller waits for the exit to be reported.
    Stopped(oneshot::Sender<()>),
    /// The agent ended without being asked to.
    Lost,
}

fn turn_error(error: &TurnError) -> TurnDone {
    let failed = |notice: String, plan| TurnDone::Failed { notice, plan };
    match error {
        TurnError::Model(ModelError::Auth(why)) if why == NOT_SIGNED_IN => {
            TurnDone::Declined { notice: SIGN_IN_NOTICE }
        }
        TurnError::Model(ModelError::LimitReached { .. }) => failed("Usage limit reached.".to_owned(), true),
        TurnError::Model(ModelError::Auth(why)) => {
            failed(format!("Claude did not accept the credentials: {why}. Check them under Settings › Accounts."), true)
        }
        TurnError::Model(error) => failed(format!("The request failed: {error}."), false),
        other => failed(format!("The turn failed: {other}."), false),
    }
}

async fn run_turn(agent: Arc<SdkAgent>, text: String) -> TurnDone {
    match agent.send_input(&text).await {
        Ok(Ok(_)) => TurnDone::Reported,
        Ok(Err(error)) => turn_error(&error),
        Err(InputError::Gone(_)) => TurnDone::Gone,
        Err(InputError::Command(error)) => TurnDone::Failed { notice: error.to_string(), plan: false },
    }
}

async fn rerun_turn(agent: Arc<SdkAgent>) -> TurnDone {
    match agent.resume().await {
        Ok(Ok(_)) => TurnDone::Reported,
        Ok(Err(error)) => turn_error(&error),
        Err(_) => TurnDone::Gone,
    }
}

fn side_of<'a>(sink: &'a Arc<dyn SessionSink>, session: &'a EngineSession) -> Side<'a> {
    Side { sink: &**sink, worker_id: session.id(), now_ms: session.shared.clock.now_ms() }
}

/// Hands a batch to the sink and waits for it: a slow sink pauses the pump,
/// and through the engine's bounded channels the agent.
async fn emit(session: &EngineSession, sink: &dyn SessionSink, live: usize, events: Vec<AgentEvent>) {
    session.live.store(live, Ordering::SeqCst);
    if !events.is_empty() {
        sink.events(session.id(), events).await;
    }
}

impl Pump {
    /// A panic in the pump ends this session as a crash; it never reaches
    /// another session or the app.
    async fn guarded(self) {
        let session = self.session.clone();
        let sink = self.sink.clone();
        if AssertUnwindSafe(self.run()).catch_unwind().await.is_err() {
            tracing::error!(worker_id = session.id(), "a session's event pump panicked");
            if session.close() {
                crashed(&*sink, session.id()).await;
            }
        }
    }

    /// One of the agent's own events. A tool's result is recorded after
    /// everything its subagent and its tasks reported before it returned:
    /// those were sent first, on channels of their own.
    fn own(&mut self, event: EngineEvent, out: &mut Vec<AgentEvent>) {
        match &event {
            EngineEvent::ToolResult { .. } => self.others(out),
            EngineEvent::RateLimit(info) => {
                if let Some(credential) = self.session.credential() {
                    self.session.shared.credentials.observed(&credential, &limits(info));
                }
            }
            _ => {}
        }
        let side = side_of(&self.sink, &self.session);
        out.extend(self.mapper.agent(event, &side));
    }

    /// Everything waiting on the subagent and task channels.
    fn others(&mut self, out: &mut Vec<AgentEvent>) {
        while let Ok(event) = self.subagents.try_recv() {
            self.subagent(event, out);
        }
        self.tasks(out);
    }

    fn tasks(&mut self, out: &mut Vec<AgentEvent>) {
        let side = side_of(&self.sink, &self.session);
        while let Ok(event) = self.tasks.try_recv() {
            out.extend(self.mapper.task(event, &side));
        }
    }

    /// One subagent event. Before a run's end, whatever its tasks reported
    /// first: whether it still has commands running decides if it waits.
    fn subagent(&mut self, event: SubagentEvent, out: &mut Vec<AgentEvent>) {
        if matches!(event.event, SubagentEventKind::Ended(_)) {
            self.tasks(out);
        }
        let side = side_of(&self.sink, &self.session);
        out.extend(self.mapper.subagent(event, &side));
    }

    /// Everything waiting on every channel, the agent's own events first.
    fn everything(&mut self, out: &mut Vec<AgentEvent>) {
        while let Ok(event) = self.events.try_recv() {
            self.own(event, out);
        }
        self.others(out);
    }

    async fn run(mut self) {
        let end = loop {
            let mut out = Vec::new();
            tokio::select! {
                biased;
                command = self.inbox.recv() => match command {
                    Some(Command::Turn(text)) => self.turns.push(Box::pin(run_turn(self.agent.clone(), text))),
                    Some(Command::Rerun) => self.turns.push(Box::pin(rerun_turn(self.agent.clone()))),
                    Some(Command::Stop(done)) => break End::Stopped(done),
                    // Every handle to the session is gone.
                    None => break End::Lost,
                },
                // The agent's own events go first: what a subagent reports was
                // caused by a call the agent already reported.
                event = self.events.recv() => match event {
                    Some(event) => {
                        self.own(event, &mut out);
                        for _ in 1..BATCH {
                            let Ok(event) = self.events.try_recv() else { break };
                            self.own(event, &mut out);
                        }
                    }
                    None => break End::Lost,
                },
                Some(done) = self.turns.next() => {
                    // A turn's events were all sent before its future resolved.
                    self.everything(&mut out);
                    match done {
                        TurnDone::Reported => {}
                        TurnDone::Failed { notice, plan } => {
                            let silenced = self.session.silenced.swap(false, Ordering::SeqCst) && plan;
                            let side = side_of(&self.sink, &self.session);
                            let failed = self.mapper.turn_failed((!silenced).then_some(notice.as_str()), &side);
                            out.extend(failed);
                        }
                        TurnDone::Declined { notice } => {
                            let side = side_of(&self.sink, &self.session);
                            out.extend(self.mapper.turn_declined(notice, &side));
                        }
                        TurnDone::Gone => break End::Lost,
                    }
                },
                Some(event) = self.subagents.recv() => self.subagent(event, &mut out),
                Some(event) = self.tasks.recv() => {
                    let side = side_of(&self.sink, &self.session);
                    let mapped = self.mapper.task(event, &side);
                    out.extend(mapped);
                },
            }
            emit(&self.session, &*self.sink, self.mapper.live(), out).await;
        };

        // The session is going away: what was still running in it is reported stopped.
        let stopped = matches!(end, End::Stopped(_));
        if stopped {
            self.agent.interrupt();
        }
        let side = side_of(&self.sink, &self.session);
        let closing = self.mapper.stop_live(&side);
        emit(&self.session, &*self.sink, self.mapper.live(), closing).await;
        let Pump { session, agent, turns, sink, .. } = self;
        drop(turns);
        drop(agent);
        let was_alive = session.close();
        match end {
            End::Stopped(done) => {
                if was_alive {
                    sink.exited(session.id(), Some(143)).await;
                }
                let _ = done.send(());
            }
            End::Lost if was_alive => crashed(&*sink, session.id()).await,
            End::Lost => {}
        }
    }
}

/// The exit first, then the session's end: whoever handles the exit reads the
/// worker's state, which the end event would already have moved on.
async fn crashed(sink: &dyn SessionSink, worker_id: &str) {
    sink.exited(worker_id, Some(1)).await;
    let ended = AgentEvent::Session(SessionEvent {
        phase: SessionEventPhase::Ended,
        outcome: Some(SessionEventOutcome::Crashed),
        session_id: None,
    });
    sink.events(worker_id, vec![ended]).await;
}

fn command_source(origin: &SkillOrigin) -> CommandItemSource {
    match origin {
        SkillOrigin::Bundled => CommandItemSource::Claude,
        SkillOrigin::UserSkill | SkillOrigin::ProjectSkill => CommandItemSource::Skill,
        SkillOrigin::UserCommand => CommandItemSource::User,
        SkillOrigin::ProjectCommand => CommandItemSource::Project,
        _ => CommandItemSource::Plugin,
    }
}

impl AgentSession for EngineSession {
    fn worker_id(&self) -> &str {
        &self.worker_id
    }

    fn capabilities(&self) -> &AgentCapabilities {
        &self.shared.capabilities
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send(&self, text: String) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(self.command(Command::Turn(text)))
    }

    fn interrupt(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Ok(agent) = self.agent() {
                agent.interrupt();
            }
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (done, stopped) = oneshot::channel();
            if self.command(Command::Stop(done)).await.is_ok() {
                let _ = stopped.await;
            }
        })
    }

    fn set_model<'a>(&'a self, model: &'a str, effort: Option<&'a str>) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let agent = self.agent()?;
            agent.set_model(model).await.map_err(failed)?;
            if effort.is_some() {
                agent.set_effort(effort).await.map_err(|_| SessionError::Gone)?;
            }
            Ok(())
        })
    }

    fn clear_context(&self) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move { self.agent()?.rewind(0).await.map_err(failed) })
    }

    fn read_transcript(&self) -> BoxFuture<'_, Result<Option<SessionTranscript>, SessionError>> {
        Box::pin(async move {
            let messages = self.agent()?.transcript().await.map_err(failed)?;
            let entries = transcript::entries(&messages);
            if entries.is_empty() {
                return Ok(None);
            }
            Ok(Some(SessionTranscript { entries, path: Some((self.shared.transcript_path)(&self.worker_id)) }))
        })
    }

    fn replace_context(&self, seed: String) -> BoxFuture<'_, Result<(), SessionError>> {
        // The seed opens the conversation ahead of the next message (a rewind
        // to that message keeps it), as TypeScript's `shouldQuery: false` push.
        Box::pin(async move {
            let replaced = self.agent()?.replace_context(seed).await.map_err(|_| SessionError::Gone)?;
            replaced.map_err(failed)
        })
    }

    fn rewind_targets(&self) -> BoxFuture<'_, Result<Vec<RewindTarget>, SessionError>> {
        Box::pin(async move { Ok(self.prompts().await?.1.into_iter().map(|p| p.target).collect()) })
    }

    fn rewind<'a>(&'a self, uuid: &'a str, mode: RewindMode) -> BoxFuture<'a, Result<Rewound, SessionError>> {
        Box::pin(async move {
            // The engine keeps no file checkpoints: code alone cannot be
            // restored; with the conversation, the conversation is.
            if mode == RewindMode::Code {
                return Err(SessionError::Unsupported("file rewind"));
            }
            let (agent, prompts) = self.prompts().await?;
            let index = prompts
                .iter()
                .position(|p| p.target.uuid == uuid)
                .ok_or_else(|| SessionError::Failed("message not found on the active branch".into()))?;
            let prompt = &prompts[index];
            agent.rewind(prompt.keep).await.map_err(failed)?;
            Ok(Rewound {
                uuid: prompt.target.uuid.clone(),
                text: prompt.target.text.clone(),
                display: prompt.target.display.clone(),
                index: i64::try_from(index).unwrap_or(i64::MAX),
            })
        })
    }

    fn recall_last_user_turn(&self) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let (agent, prompts) = self.prompts().await?;
            // Nothing was said yet: there is nothing to take back.
            let Some(last) = prompts.last() else { return Ok(()) };
            agent.rewind(last.keep).await.map_err(failed)
        })
    }

    fn live_subagents(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }

    fn stop_task<'a>(&'a self, task_id: &'a str) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move { self.agent()?.stop_task(task_id).await.map(|_| ()).map_err(failed) })
    }

    fn ask_side(&self, question: String) -> BoxFuture<'_, Result<String, SessionError>> {
        Box::pin(async move { self.agent()?.ask_side(&question).await.map_err(failed) })
    }

    fn switch_account(&self, credential: SessionCredential) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let agent = self.agent()?;
            agent.set_auth(self.shared.accounts.of(&credential));
            self.shared.credentials.launched(&self.worker_id, Some(&credential));
            self.set_credential(Some(credential));
            self.command(Command::Rerun).await
        })
    }

    fn commands(&self) -> Vec<CommandItem> {
        let Ok(agent) = self.agent() else { return Vec::new() };
        agent
            .commands()
            .into_iter()
            .filter(|c| c.user_invocable)
            .map(|c| CommandItem {
                name: c.name,
                description: c.description,
                source: command_source(&c.source),
                argument_hint: c.argument_hint,
            })
            .collect()
    }
}
