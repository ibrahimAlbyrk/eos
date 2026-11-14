//! A scripted agent runtime: sessions that emit canonical events without a
//! model, so every feature that touches an agent can be tested.
//!
//! ```ignore
//! let agents = ScriptedRuntime::new();
//! agents.script(Turn::reply("done"));              // the next message gets this turn
//! let gate = agents.script_held(Turn::reply("…")); // a turn that waits until released
//! …drive the feature…
//! agents.settled().await;                          // every started turn has ended
//! assert_eq!(agents.sent("w-1"), ["hello"]);
//! ```
//!
//! A message with no scripted turn left gets what [`ScriptedRuntime::otherwise`]
//! makes for it, else `Turn::reply("ok")`. A long run builds the runtime with
//! [`ScriptedRuntime::unlogged`], which keeps no record of the calls.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use eos_contracts::{
    AgentEvent, AgentMessageEvent, AgentMessageEventRole, CanonicalUsage, CommandItem, ContentBlock, RewindMode,
    RewindTarget, SessionEvent, SessionEventPhase, TextBlock, ToolCallBlock, ToolResultBlock, TurnEvent,
    TurnEventPhase, UiBackendDescriptorBilling, UiBackendDescriptorCatalog, UiBackendDescriptorSessionStore,
    UnknownRecord, UsageEvent, WorkflowRunProgress,
};
use eos_core::accounts::SessionCredential;
use eos_core::agent::{
    AgentCapabilities, AgentRuntime, AgentSession, BackendAuth, BackendDescriptor, BackgroundTaskUpdate, LaunchSpec,
    ModelSource, Rewound, SessionError, SessionSink, SessionTranscript, ToolInputDelta, TranscriptEntry,
};
use eos_core::{BoxFuture, Error};
use tokio::sync::{Notify, watch};

/// Canonical events as a real session emits them.
pub mod events {
    use super::*;

    pub fn turn(phase: TurnEventPhase, reason: Option<&str>) -> AgentEvent {
        AgentEvent::Turn(TurnEvent { phase, reason: reason.map(str::to_owned) })
    }

    pub fn session(phase: SessionEventPhase, session_id: Option<&str>) -> AgentEvent {
        AgentEvent::Session(SessionEvent { phase, outcome: None, session_id: session_id.map(str::to_owned) })
    }

    pub fn assistant(blocks: Vec<ContentBlock>) -> AgentEvent {
        AgentEvent::Message(AgentMessageEvent { role: AgentMessageEventRole::Assistant, blocks, model: None })
    }

    pub fn text(text: &str, block_id: &str) -> AgentEvent {
        assistant(vec![ContentBlock::Text(TextBlock {
            text: text.to_owned(),
            block_id: Some(block_id.to_owned()),
            msg_id: None,
        })])
    }

    pub fn tool_call(call_id: &str, name: &str, input: UnknownRecord) -> AgentEvent {
        assistant(vec![ContentBlock::ToolCall(ToolCallBlock {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            input,
            parent_call_id: None,
            spawns_subagent: None,
        })])
    }

    pub fn tool_result(call_id: &str, content: &str, is_error: bool) -> AgentEvent {
        AgentEvent::Message(AgentMessageEvent {
            role: AgentMessageEventRole::Tool,
            blocks: vec![ContentBlock::ToolResult(ToolResultBlock {
                call_id: call_id.to_owned(),
                is_error,
                content: content.to_owned(),
                patch: None,
            })],
            model: None,
        })
    }

    pub fn usage(input: i64, output: i64) -> AgentEvent {
        AgentEvent::Usage(UsageEvent {
            usage: CanonicalUsage {
                input_tokens: input.into(),
                output_tokens: output.into(),
                cache_read_tokens: 0.into(),
                cache_write_tokens: Default::default(),
                model: Some(None),
            },
        })
    }
}

/// One scripted turn: the events between `turn started` and the turn's end.
#[derive(Debug, Clone)]
pub struct Turn {
    body: Vec<AgentEvent>,
    end: AgentEvent,
    hold: Option<Arc<Notify>>,
    /// What the session tells its sink besides events, after the body.
    effects: Vec<Effect>,
    /// How long the turn runs after its body before it ends.
    takes: Option<Duration>,
}

#[derive(Debug, Clone)]
enum Effect {
    Background(BackgroundTaskUpdate),
    Workflow(WorkflowRunProgress),
}

impl Turn {
    /// The agent answers with `text`.
    pub fn reply(text: &str) -> Self {
        Self::of(vec![events::text(text, "m1:0")])
    }

    /// The agent calls a tool, gets `result`, then answers `text`.
    pub fn tool(name: &str, input: UnknownRecord, result: &str, text: &str) -> Self {
        Self::of(vec![
            events::tool_call("toolu_1", name, input),
            events::tool_result("toolu_1", result, false),
            events::text(text, "m2:0"),
        ])
    }

    /// These events, then usage and `turn ended`.
    pub fn of(mut body: Vec<AgentEvent>) -> Self {
        body.push(events::usage(10, 5));
        Self { body, end: events::turn(TurnEventPhase::Ended, None), hold: None, effects: Vec::new(), takes: None }
    }

    /// A background command or monitor of the session moves on during the turn.
    pub fn with_background(mut self, update: BackgroundTaskUpdate) -> Self {
        self.effects.push(Effect::Background(update));
        self
    }

    /// A workflow run of the session reports progress during the turn.
    pub fn with_workflow(mut self, progress: WorkflowRunProgress) -> Self {
        self.effects.push(Effect::Workflow(progress));
        self
    }

    /// The turn runs this long after its body before it ends (an interrupt
    /// cuts it short).
    pub fn taking(mut self, duration: Duration) -> Self {
        self.takes = Some(duration);
        self
    }

    /// The turn ends in an error instead.
    pub fn failing(mut self, reason: &str) -> Self {
        self.end = events::turn(TurnEventPhase::Error, Some(reason));
        self
    }
}

/// Lets a held turn finish.
#[derive(Debug, Clone)]
pub struct Release(Arc<Notify>);

impl Release {
    pub fn release(&self) {
        self.0.notify_one();
    }
}

/// What a test can ask a runtime about afterwards.
#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    Start(Box<LaunchSpec>),
    Send { worker_id: String, text: String },
    Interrupt(String),
    Stop(String),
    SetModel { worker_id: String, model: String, effort: Option<String> },
    ClearContext(String),
    ReplaceContext { worker_id: String, seed: String },
    Rewind { worker_id: String, uuid: String },
    Recall(String),
    StopTask { worker_id: String, task_id: String },
    AskSide { worker_id: String, question: String },
    SwitchAccount { worker_id: String, credential: SessionCredential },
}

/// Makes the turn for a message no scripted turn is left for: (worker, text).
type Fallback = Arc<dyn Fn(&str, &str) -> Turn + Send + Sync>;

struct Shared {
    descriptor: BackendDescriptor,
    /// Whether calls and forgotten workers are kept for the test to read.
    log: bool,
    fallback: Mutex<Option<Fallback>>,
    sessions: Mutex<HashMap<String, Arc<ScriptedSession>>>,
    turns: Mutex<VecDeque<Turn>>,
    calls: Mutex<Vec<Call>>,
    start_error: Mutex<Option<Error>>,
    /// The next start waits here before it does anything.
    start_hold: Mutex<Option<Arc<Notify>>>,
    forgotten: Mutex<Vec<String>>,
    /// Turns started and not yet ended.
    running: watch::Sender<usize>,
}

impl Shared {
    fn record(&self, call: Call) {
        if self.log {
            self.calls.lock().expect("calls").push(call);
        }
    }
}

/// An [`AgentRuntime`] whose sessions play scripted turns.
#[derive(Clone)]
pub struct ScriptedRuntime(Arc<Shared>);

impl std::fmt::Debug for ScriptedRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptedRuntime").field("live", &self.live()).finish_non_exhaustive()
    }
}

/// What a session of today's default backend can do.
pub fn claude_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        interrupt: true,
        keystroke: false,
        rewind: true,
        runtime_model_switch: true,
        runtime_permission_switch: true,
        reports_message_events: None,
        streaming_thinking: Some(true),
        resumable: Some(true),
        account_switch: Some(true),
        context_clear: Some(true),
        context_compaction: Some(true),
        expands_slash_templates: Some(true),
        side_question: Some(true),
    }
}

impl ScriptedRuntime {
    pub fn new() -> Self {
        Self::with_capabilities(claude_capabilities())
    }

    /// Keeps no record of calls or forgotten workers: for a run long enough
    /// that the record would be what grows.
    pub fn unlogged() -> Self {
        Self::build(claude_capabilities(), false)
    }

    pub fn with_capabilities(capabilities: AgentCapabilities) -> Self {
        Self::build(capabilities, true)
    }

    fn build(capabilities: AgentCapabilities, log: bool) -> Self {
        let descriptor = BackendDescriptor {
            kind: "claude".into(),
            label: "Claude".into(),
            billing: UiBackendDescriptorBilling::Subscription,
            model_source: ModelSource::Request,
            capabilities,
            catalog: Some(UiBackendDescriptorCatalog::Claude),
            auth: BackendAuth::Subscription,
            enabled: true,
            session_store: UiBackendDescriptorSessionStore::ClaudeTranscript,
            wire_dialect: None,
        };
        Self(Arc::new(Shared {
            descriptor,
            log,
            fallback: Mutex::default(),
            sessions: Mutex::default(),
            turns: Mutex::default(),
            calls: Mutex::default(),
            start_error: Mutex::default(),
            start_hold: Mutex::default(),
            forgotten: Mutex::default(),
            running: watch::Sender::new(0),
        }))
    }

    /// As the port: what features hold.
    pub fn port(&self) -> Arc<dyn AgentRuntime> {
        Arc::new(self.clone())
    }

    /// The next message (to any session) plays `turn`.
    pub fn script(&self, turn: Turn) {
        self.0.turns.lock().expect("turns").push_back(turn);
    }

    /// Like [`script`](Self::script), but the turn stops before its end and
    /// waits to be released (or interrupted).
    pub fn script_held(&self, mut turn: Turn) -> Release {
        let gate = Arc::new(Notify::new());
        turn.hold = Some(gate.clone());
        self.script(turn);
        Release(gate)
    }

    /// Makes the turn of every message no scripted turn is left for.
    pub fn otherwise(&self, make: impl Fn(&str, &str) -> Turn + Send + Sync + 'static) {
        *self.0.fallback.lock().expect("fallback") = Some(Arc::new(make));
    }

    /// The next `start` fails with `error`.
    pub fn fail_next_start(&self, error: Error) {
        *self.0.start_error.lock().expect("start error") = Some(error);
    }

    /// The next `start` waits to be released before it begins, as a session
    /// that takes a while to come up (its conversation read back) does.
    pub fn hold_next_start(&self) -> Release {
        let gate = Arc::new(Notify::new());
        *self.0.start_hold.lock().expect("start hold") = Some(gate.clone());
        Release(gate)
    }

    /// Resolves once no turn is running.
    pub async fn settled(&self) {
        let mut running = self.0.running.subscribe();
        let _ = running.wait_for(|n| *n == 0).await;
    }

    /// Resolves once `n` turns are running (a held turn has started).
    pub async fn running(&self, n: usize) {
        let mut running = self.0.running.subscribe();
        let _ = running.wait_for(|now| *now == n).await;
    }

    pub fn calls(&self) -> Vec<Call> {
        self.0.calls.lock().expect("calls").clone()
    }

    /// The messages a worker's session was sent, in order.
    pub fn sent(&self, worker_id: &str) -> Vec<String> {
        let calls = self.0.calls.lock().expect("calls");
        calls
            .iter()
            .filter_map(|c| match c {
                Call::Send { worker_id: w, text } if w == worker_id => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// The specs sessions were started with, in order.
    pub fn started(&self) -> Vec<LaunchSpec> {
        let calls = self.0.calls.lock().expect("calls");
        calls
            .iter()
            .filter_map(|c| match c {
                Call::Start(spec) => Some((**spec).clone()),
                _ => None,
            })
            .collect()
    }

    /// The workers whose recorded conversation was deleted.
    pub fn forgotten(&self) -> Vec<String> {
        self.0.forgotten.lock().expect("forgotten").clone()
    }

    /// Ends a session as if its process had died.
    pub async fn crash(&self, worker_id: &str) {
        let session = self.0.sessions.lock().expect("sessions").remove(worker_id);
        if let Some(session) = session {
            session.alive.store(false, Ordering::SeqCst);
            session.interrupt.send_modify(|n| *n += 1);
            session.sink.exited(worker_id, Some(1)).await;
        }
    }
}

impl Default for ScriptedRuntime {
    fn default() -> Self {
        Self::new()
    }
}

struct ScriptedSession {
    me: Weak<ScriptedSession>,
    worker_id: String,
    shared: Arc<Shared>,
    sink: Arc<dyn SessionSink>,
    alive: AtomicBool,
    /// Counts interrupts: a turn sees every one made after it started.
    interrupt: watch::Sender<u64>,
    /// One turn at a time, in the order sent.
    order: tokio::sync::Mutex<()>,
    said: Mutex<Vec<TranscriptEntry>>,
}

/// Counts a turn as running until dropped.
struct Running(Arc<Shared>);

impl Running {
    fn start(shared: &Arc<Shared>) -> Self {
        shared.running.send_modify(|n| *n += 1);
        Self(shared.clone())
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.0.running.send_modify(|n| *n -= 1);
    }
}

impl ScriptedSession {
    fn gone(&self) -> Result<(), SessionError> {
        if self.alive.load(Ordering::SeqCst) { Ok(()) } else { Err(SessionError::Gone) }
    }

    fn begin(&self, text: String) {
        let Some(session) = self.me.upgrade() else { return };
        let scripted = self.shared.turns.lock().expect("turns").pop_front();
        let turn = scripted.unwrap_or_else(|| {
            let fallback = self.shared.fallback.lock().expect("fallback").clone();
            fallback.map_or_else(|| Turn::reply("ok"), |make| make(&self.worker_id, &text))
        });
        let running = Running::start(&self.shared);
        tokio::spawn(async move {
            let _running = running;
            let _order = session.order.lock().await;
            session.play(text, turn).await;
        });
    }

    async fn play(&self, text: String, turn: Turn) {
        if !self.alive.load(Ordering::SeqCst) {
            return;
        }
        let mut interrupted = self.interrupt.subscribe();
        self.said.lock().expect("said").push(TranscriptEntry::User { text });
        let id = self.worker_id.as_str();
        let mut batch = vec![events::turn(TurnEventPhase::Started, None)];
        batch.extend(turn.body);
        if turn.hold.is_some() || turn.takes.is_some() || !turn.effects.is_empty() {
            self.sink.events(id, std::mem::take(&mut batch)).await;
        }
        for effect in turn.effects {
            match effect {
                Effect::Background(update) => self.sink.background_task(id, update),
                Effect::Workflow(progress) => self.sink.workflow_progress(progress),
            }
        }
        if turn.hold.is_some() || turn.takes.is_some() {
            let gate = turn.hold.unwrap_or_default();
            let takes = turn.takes.unwrap_or(Duration::MAX);
            tokio::select! {
                () = gate.notified() => {}
                () = tokio::time::sleep(takes) => {}
                _ = interrupted.changed() => {
                    if self.alive.load(Ordering::SeqCst) {
                        let aborted = events::turn(TurnEventPhase::Aborted, Some("interrupted"));
                        self.sink.events(id, vec![aborted]).await;
                    }
                    return;
                }
            }
        }
        batch.push(turn.end);
        self.sink.events(id, batch).await;
    }
}

impl AgentSession for ScriptedSession {
    fn worker_id(&self) -> &str {
        &self.worker_id
    }

    fn capabilities(&self) -> &AgentCapabilities {
        &self.shared.descriptor.capabilities
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send(&self, text: String) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            self.shared.record(Call::Send { worker_id: self.worker_id.clone(), text: text.clone() });
            self.begin(text);
            Ok(())
        })
    }

    fn interrupt(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.shared.record(Call::Interrupt(self.worker_id.clone()));
            self.interrupt.send_modify(|n| *n += 1);
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if !self.alive.swap(false, Ordering::SeqCst) {
                return;
            }
            self.shared.record(Call::Stop(self.worker_id.clone()));
            self.shared.sessions.lock().expect("sessions").remove(&self.worker_id);
            self.interrupt.send_modify(|n| *n += 1);
            self.sink.exited(&self.worker_id, Some(143)).await;
        })
    }

    fn set_model<'a>(&'a self, model: &'a str, effort: Option<&'a str>) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            self.shared.record(Call::SetModel {
                worker_id: self.worker_id.clone(),
                model: model.to_owned(),
                effort: effort.map(str::to_owned),
            });
            Ok(())
        })
    }

    fn clear_context(&self) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            self.shared.record(Call::ClearContext(self.worker_id.clone()));
            self.said.lock().expect("said").clear();
            Ok(())
        })
    }

    fn read_transcript(&self) -> BoxFuture<'_, Result<Option<SessionTranscript>, SessionError>> {
        Box::pin(async move {
            self.gone()?;
            let entries = self.said.lock().expect("said").clone();
            Ok((!entries.is_empty()).then_some(SessionTranscript { entries, path: None }))
        })
    }

    fn replace_context(&self, seed: String) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            *self.said.lock().expect("said") = vec![TranscriptEntry::User { text: seed.clone() }];
            self.shared.record(Call::ReplaceContext { worker_id: self.worker_id.clone(), seed });
            Ok(())
        })
    }

    fn rewind_targets(&self) -> BoxFuture<'_, Result<Vec<RewindTarget>, SessionError>> {
        Box::pin(async move {
            self.gone()?;
            let said = self.said.lock().expect("said");
            let prompts: Vec<&str> = said
                .iter()
                .filter_map(|e| match e {
                    TranscriptEntry::User { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let count = prompts.len();
            Ok(prompts
                .into_iter()
                .enumerate()
                .map(|(i, text)| RewindTarget {
                    uuid: format!("m{i}"),
                    text: text.to_owned(),
                    display: text.to_owned(),
                    ts: String::new(),
                    up_count: i64::try_from(count - i).unwrap_or(0),
                })
                .collect())
        })
    }

    fn rewind<'a>(&'a self, uuid: &'a str, _mode: RewindMode) -> BoxFuture<'a, Result<Rewound, SessionError>> {
        Box::pin(async move {
            let targets = self.rewind_targets().await?;
            let index = targets
                .iter()
                .position(|t| t.uuid == uuid)
                .ok_or_else(|| SessionError::Failed("message not found on the active branch".into()))?;
            self.shared.record(Call::Rewind { worker_id: self.worker_id.clone(), uuid: uuid.to_owned() });
            self.said.lock().expect("said").truncate(index);
            let target = &targets[index];
            Ok(Rewound {
                uuid: target.uuid.clone(),
                text: target.text.clone(),
                display: target.display.clone(),
                index: i64::try_from(index).unwrap_or(0),
            })
        })
    }

    fn recall_last_user_turn(&self) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            self.shared.record(Call::Recall(self.worker_id.clone()));
            self.said.lock().expect("said").pop();
            Ok(())
        })
    }

    fn live_subagents(&self) -> usize {
        0
    }

    fn stop_task<'a>(&'a self, task_id: &'a str) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            self.shared.record(Call::StopTask { worker_id: self.worker_id.clone(), task_id: task_id.to_owned() });
            Ok(())
        })
    }

    fn ask_side(&self, question: String) -> BoxFuture<'_, Result<String, SessionError>> {
        Box::pin(async move {
            self.gone()?;
            let answer = format!("side answer to: {question}");
            self.shared.record(Call::AskSide { worker_id: self.worker_id.clone(), question });
            Ok(answer)
        })
    }

    fn switch_account(&self, credential: SessionCredential) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.gone()?;
            self.shared.record(Call::SwitchAccount { worker_id: self.worker_id.clone(), credential });
            Ok(())
        })
    }

    fn commands(&self) -> Vec<CommandItem> {
        Vec::new()
    }
}

impl AgentRuntime for ScriptedRuntime {
    fn descriptor(&self) -> &BackendDescriptor {
        &self.0.descriptor
    }

    fn start(
        &self,
        spec: LaunchSpec,
        sink: Arc<dyn SessionSink>,
    ) -> BoxFuture<'_, Result<Arc<dyn AgentSession>, Error>> {
        Box::pin(async move {
            let hold = self.0.start_hold.lock().expect("start hold").take();
            if let Some(gate) = hold {
                gate.notified().await;
            }
            if let Some(error) = self.0.start_error.lock().expect("start error").take() {
                return Err(error);
            }
            let worker_id = spec.worker_id.clone();
            let prompt = spec.prompt.clone();
            self.0.record(Call::Start(Box::new(spec)));
            let session = Arc::new_cyclic(|me| ScriptedSession {
                me: me.clone(),
                worker_id: worker_id.clone(),
                shared: self.0.clone(),
                sink: sink.clone(),
                alive: AtomicBool::new(true),
                interrupt: watch::Sender::new(0),
                order: tokio::sync::Mutex::new(()),
                said: Mutex::default(),
            });
            self.0.sessions.lock().expect("sessions").insert(worker_id.clone(), session.clone());
            let up = vec![
                events::session(SessionEventPhase::Started, None),
                events::session(SessionEventPhase::Ready, Some(&worker_id)),
            ];
            sink.events(&worker_id, up).await;
            if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
                session.begin(prompt);
            }
            Ok(session as Arc<dyn AgentSession>)
        })
    }

    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        let session = self.0.sessions.lock().expect("sessions").get(worker_id).cloned()?;
        Some(session)
    }

    fn live(&self) -> usize {
        self.0.sessions.lock().expect("sessions").len()
    }

    fn forget<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        if self.0.log {
            self.0.forgotten.lock().expect("forgotten").push(worker_id.to_owned());
        }
        Box::pin(std::future::ready(()))
    }
}

/// A sink that keeps everything it hears, for tests of a runtime itself.
#[derive(Debug, Default)]
pub struct RecordingSink {
    /// Bumped on every call, for [`until`](Self::until).
    heard: watch::Sender<u64>,
    pub events: Mutex<Vec<(String, AgentEvent)>>,
    pub exits: Mutex<Vec<(String, Option<i32>)>>,
    /// The tools whose input is followed.
    pub follows: Mutex<Vec<String>>,
    pub tool_inputs: Mutex<Vec<ToolInputDelta>>,
    pub workflow: Mutex<Vec<WorkflowRunProgress>>,
    pub tasks: Mutex<Vec<BackgroundTaskUpdate>>,
}

impl RecordingSink {
    /// Resolves once `done` holds for a worker's events so far (as JSON).
    pub async fn until(&self, worker_id: &str, done: impl Fn(&[serde_json::Value]) -> bool) -> Vec<serde_json::Value> {
        let mut heard = self.heard.subscribe();
        loop {
            let events = self.json(worker_id);
            if done(&events) {
                return events;
            }
            if heard.changed().await.is_err() {
                return events;
            }
        }
    }

    /// Resolves once the worker's session has exited, with its code.
    pub async fn exit(&self, worker_id: &str) -> Option<i32> {
        let mut heard = self.heard.subscribe();
        loop {
            let found = self.exits.lock().expect("exits").iter().find(|(w, _)| w == worker_id).map(|(_, c)| *c);
            if let Some(code) = found {
                return code;
            }
            if heard.changed().await.is_err() {
                return None;
            }
        }
    }

    /// The events of one worker as JSON, in order.
    pub fn json(&self, worker_id: &str) -> Vec<serde_json::Value> {
        let events = self.events.lock().expect("events");
        events
            .iter()
            .filter(|(w, _)| w == worker_id)
            .map(|(_, e)| serde_json::to_value(e).expect("an event serializes"))
            .collect()
    }
}

impl SessionSink for RecordingSink {
    fn events<'a>(&'a self, worker_id: &'a str, events: Vec<AgentEvent>) -> BoxFuture<'a, ()> {
        self.events.lock().expect("events").extend(events.into_iter().map(|e| (worker_id.to_owned(), e)));
        self.heard.send_modify(|n| *n += 1);
        Box::pin(std::future::ready(()))
    }

    fn exited<'a>(&'a self, worker_id: &'a str, code: Option<i32>) -> BoxFuture<'a, ()> {
        self.exits.lock().expect("exits").push((worker_id.to_owned(), code));
        self.heard.send_modify(|n| *n += 1);
        Box::pin(std::future::ready(()))
    }

    fn follows_tool_input(&self, tool: &str) -> bool {
        self.follows.lock().expect("follows").iter().any(|t| t == tool)
    }

    fn tool_input(&self, _worker_id: &str, delta: ToolInputDelta) {
        self.tool_inputs.lock().expect("tool inputs").push(delta);
    }

    fn workflow_progress(&self, progress: WorkflowRunProgress) {
        self.workflow.lock().expect("workflow").push(progress);
    }

    fn background_task(&self, _worker_id: &str, update: BackgroundTaskUpdate) {
        self.tasks.lock().expect("tasks").push(update);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(sink: &RecordingSink, worker: &str) -> Vec<String> {
        sink.json(worker)
            .iter()
            .map(|e| match e["type"].as_str() {
                Some("turn") => format!("turn:{}", e["phase"].as_str().unwrap_or_default()),
                Some("session") => format!("session:{}", e["phase"].as_str().unwrap_or_default()),
                other => other.unwrap_or_default().to_owned(),
            })
            .collect()
    }

    #[tokio::test]
    async fn a_session_plays_its_turns_in_order() {
        let agents = ScriptedRuntime::new();
        let sink = Arc::new(RecordingSink::default());
        agents.script(Turn::reply("first"));
        let mut spec = LaunchSpec::new("w-1", "/tmp", "opus");
        spec.prompt = Some("hello".into());
        let session = agents.start(spec, sink.clone()).await.expect("starts");
        session.send("again".into()).await.expect("sends");
        agents.settled().await;

        assert_eq!(
            kinds(&sink, "w-1"),
            [
                "session:started",
                "session:ready",
                "turn:started",
                "message",
                "usage",
                "turn:ended",
                "turn:started",
                "message",
                "usage",
                "turn:ended"
            ]
        );
        assert_eq!(sink.json("w-1")[1]["sessionId"], "w-1");
        assert_eq!(sink.json("w-1")[3]["blocks"][0]["text"], "first");
        assert_eq!(sink.json("w-1")[7]["blocks"][0]["text"], "ok", "an unscripted message gets the default turn");
        assert_eq!(agents.sent("w-1"), ["again"], "the first prompt rides the start");
        assert_eq!(agents.started()[0].prompt.as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn a_held_turn_ends_when_released_or_interrupted() {
        let agents = ScriptedRuntime::new();
        let sink = Arc::new(RecordingSink::default());
        let session = agents.start(LaunchSpec::new("w-1", "/tmp", "opus"), sink.clone()).await.expect("starts");

        let gate = agents.script_held(Turn::reply("slow"));
        session.send("one".into()).await.expect("sends");
        agents.running(1).await;
        gate.release();
        agents.settled().await;
        assert_eq!(kinds(&sink, "w-1").last().map(String::as_str), Some("turn:ended"));

        let _gate = agents.script_held(Turn::reply("never"));
        session.send("two".into()).await.expect("sends");
        agents.running(1).await;
        // The turn is parked on its gate once its first events are out.
        while sink.json("w-1").last().map(|e| e["type"] == "usage") != Some(true) {
            tokio::task::yield_now().await;
        }
        session.interrupt().await;
        agents.settled().await;
        let last = sink.json("w-1").pop().expect("an event");
        assert_eq!((last["phase"].as_str(), last["reason"].as_str()), (Some("aborted"), Some("interrupted")));
    }

    #[tokio::test]
    async fn a_stopped_session_is_gone() {
        let agents = ScriptedRuntime::new();
        let sink = Arc::new(RecordingSink::default());
        let session = agents.start(LaunchSpec::new("w-1", "/tmp", "opus"), sink.clone()).await.expect("starts");
        assert_eq!(agents.live(), 1);
        session.stop().await;
        session.stop().await;
        assert_eq!(*sink.exits.lock().expect("exits"), [("w-1".to_owned(), Some(143))]);
        assert_eq!(agents.live(), 0);
        assert!(agents.session("w-1").is_none());
        assert_eq!(session.send("late".into()).await, Err(SessionError::Gone));

        agents.fail_next_start(Error::Rule("no credential".into()));
        let refused = agents.start(LaunchSpec::new("w-2", "/tmp", "opus"), sink).await;
        assert_eq!(refused.err(), Some(Error::Rule("no credential".into())));
    }
}
