//! Running agent sessions (`AgentBackend` / `AgentSession` of
//! `core/src/ports/AgentBackend.ts`).
//!
//! A runtime starts sessions; a session is one live conversation of one
//! worker. Everything a session reports goes to the [`SessionSink`] it was
//! started with, in order. Callers gate on the session's
//! [`capabilities`](AgentSession::capabilities) before an optional operation;
//! a session that cannot do it answers [`SessionError::Unsupported`].

use std::sync::Arc;

use eos_contracts::{AgentEvent, CommandItem, RewindMode, RewindTarget, SessionFactsRole, WorkflowRunProgress};

use super::descriptor::{AgentCapabilities, BackendDescriptor};
use super::{ToolInputDelta, ToolInputPhase};
use crate::accounts::SessionCredential;
use crate::{BoxFuture, Error};

/// Everything needed to start one session. Free of engine types: the runtime
/// turns it into its own options.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchSpec {
    /// The worker row this session belongs to; also the session's id.
    pub worker_id: String,
    /// The folder it works in (the worktree, when it has one).
    pub cwd: String,
    /// More folders its tools may touch (the project's other folders).
    pub additional_dirs: Vec<String>,
    /// A model id or alias the runtime resolves.
    pub model: String,
    pub effort: Option<String>,
    pub role: SessionFactsRole,
    pub parent_id: Option<String>,
    /// The peer tools are on.
    pub collaborate: bool,
    pub worker_definition: Option<String>,
    /// The text that follows the engine's own system prompt, assembled at
    /// the spawn chokepoint; `None` appends nothing.
    pub system_prompt: Option<String>,
    /// The first message, sent as soon as the session is up.
    pub prompt: Option<String>,
    /// Continue the conversation recorded under this session id (the worker
    /// row's `session_id`) instead of starting an empty one.
    pub resume: Option<String>,
    /// The credential it runs on; `None` leaves the choice to the runtime
    /// (the accounts feature's pick for a new session).
    pub credential: Option<SessionCredential>,
}

impl LaunchSpec {
    /// A top-level worker in `cwd` with nothing else set.
    pub fn new(worker_id: impl Into<String>, cwd: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            worker_id: worker_id.into(),
            cwd: cwd.into(),
            additional_dirs: Vec::new(),
            model: model.into(),
            effort: None,
            role: SessionFactsRole::Worker,
            parent_id: None,
            collaborate: false,
            worker_definition: None,
            system_prompt: None,
            prompt: None,
            resume: None,
            credential: None,
        }
    }

    /// A focused session is a plain coding session: the full built-in tool
    /// surface, with only permissions going through Eos.
    pub fn is_focused(&self) -> bool {
        self.role == SessionFactsRole::Focused
    }

    pub fn is_orchestrator(&self) -> bool {
        self.role == SessionFactsRole::Orchestrator
    }
}

/// Why a session operation did not happen.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    /// The session has ended.
    #[error("session gone")]
    Gone,
    /// This session cannot do that (its capabilities say so).
    #[error("{0} unavailable on this session")]
    Unsupported(&'static str),
    /// It was tried and failed; the text is for the user.
    #[error("{0}")]
    Failed(String),
}

/// How a background task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome {
    Completed,
    Failed,
    Stopped,
}

impl TaskOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundTaskKind {
    Shell,
    Monitor,
}

/// A background command or monitor of a session, for the job list. Not an
/// agent event: it is never logged. (Workflow runs start and end through
/// their own agent events.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundTaskUpdate {
    Started {
        task_id: String,
        /// The tool call that started it.
        call_id: String,
        kind: BackgroundTaskKind,
        title: String,
        command: Option<String>,
        output_file: Option<String>,
    },
    /// Its output file has grown.
    Output { task_id: String, output_file: String },
    Ended {
        task_id: String,
        outcome: TaskOutcome,
        summary: Option<String>,
        output_file: Option<String>,
        exit_code: Option<i64>,
    },
}

/// One entry of a conversation as a summarizer reads it
/// (`core/src/domain/transcript.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptEntry {
    User { text: String },
    Assistant { text: String },
    ToolCall { name: String, input: String },
    ToolResult { text: String, is_error: bool },
}

/// A session's live conversation, lane-neutral.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionTranscript {
    pub entries: Vec<TranscriptEntry>,
    /// Where the full conversation stays readable on disk, if anywhere.
    pub path: Option<String>,
}

/// What a rewind went back to, for the composer to offer again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewound {
    pub uuid: String,
    pub text: String,
    pub display: String,
    /// The target's position among the rewind targets, oldest first.
    pub index: i64,
}

/// Where a session reports. One sink serves every session; calls for one
/// worker arrive in order, and the session waits for [`events`](Self::events)
/// and [`exited`](Self::exited) to return before it goes on, so a slow
/// consumer pauses the agent instead of letting events pile up.
pub trait SessionSink: Send + Sync + 'static {
    /// Canonical events, oldest first; live text deltas included.
    fn events<'a>(&'a self, worker_id: &'a str, events: Vec<AgentEvent>) -> BoxFuture<'a, ()>;

    /// The session is over: `0` it ended by itself, `1` it crashed, `143` it
    /// was stopped.
    fn exited<'a>(&'a self, worker_id: &'a str, code: Option<i32>) -> BoxFuture<'a, ()>;

    /// Whether a feature follows this tool's input while the model writes it.
    fn follows_tool_input(&self, _tool: &str) -> bool {
        false
    }

    /// One piece of a followed tool's input. Must not block.
    fn tool_input(&self, _worker_id: &str, _delta: ToolInputDelta) {}

    /// A running workflow's latest snapshot. Must not block.
    fn workflow_progress(&self, _progress: WorkflowRunProgress) {}

    /// A background command or monitor moved on. Must not block.
    fn background_task(&self, _worker_id: &str, _update: BackgroundTaskUpdate) {}
}

/// One live session.
pub trait AgentSession: Send + Sync + 'static {
    fn worker_id(&self) -> &str;
    fn capabilities(&self) -> &AgentCapabilities;
    fn is_alive(&self) -> bool;

    /// Delivers a message as a new turn. Resolves when the session has taken
    /// it, not when the turn ends (that arrives as a `turn` event).
    fn send(&self, text: String) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Stops the running turn; background work of the session goes on.
    fn interrupt(&self) -> BoxFuture<'_, ()>;

    /// Ends the session and its running turn. The sink hears `exited(143)`.
    /// Does nothing on a session that is already over.
    fn stop(&self) -> BoxFuture<'_, ()>;

    /// Runs later turns on `model` (and `effort`, when given).
    fn set_model<'a>(&'a self, model: &'a str, effort: Option<&'a str>) -> BoxFuture<'a, Result<(), SessionError>>;

    /// Starts over with an empty conversation (`/clear`).
    fn clear_context(&self) -> BoxFuture<'_, Result<(), SessionError>>;

    /// The conversation as a summarizer reads it; `None` before anything was said.
    fn read_transcript(&self) -> BoxFuture<'_, Result<Option<SessionTranscript>, SessionError>>;

    /// Replaces the conversation with `seed`, which runs no turn: the model
    /// reads it with the next message.
    fn replace_context(&self, seed: String) -> BoxFuture<'_, Result<(), SessionError>>;

    /// The user's earlier prompts a rewind can go back to, oldest first.
    fn rewind_targets(&self) -> BoxFuture<'_, Result<Vec<RewindTarget>, SessionError>>;

    /// Cuts the conversation back to just before the prompt `uuid`.
    fn rewind<'a>(&'a self, uuid: &'a str, mode: RewindMode) -> BoxFuture<'a, Result<Rewound, SessionError>>;

    /// Takes back the last prompt, which the agent has not answered: it
    /// reaches neither the next turn nor a later resume.
    fn recall_last_user_turn(&self) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Background subagents, workflow runs and commands still running in it.
    fn live_subagents(&self) -> usize;

    /// Stops one background task; the task's own end event closes it.
    fn stop_task<'a>(&'a self, task_id: &'a str) -> BoxFuture<'a, Result<(), SessionError>>;

    /// Answers a question from the conversation as it stands, without
    /// touching it. Dropping the future cancels the question.
    fn ask_side(&self, question: String) -> BoxFuture<'_, Result<String, SessionError>>;

    /// Moves the session to another credential and runs the turn the old one
    /// cut off again.
    fn switch_account(&self, credential: SessionCredential) -> BoxFuture<'_, Result<(), SessionError>>;

    /// The skills and slash commands a user can type in it.
    fn commands(&self) -> Vec<CommandItem>;
}

/// The agent engine.
pub trait AgentRuntime: Send + Sync + 'static {
    fn descriptor(&self) -> &BackendDescriptor;

    /// Starts a session for `spec.worker_id` and returns once it is up: the
    /// sink has heard `session started` and `session ready`, the first prompt
    /// (if any) is on its way. A worker has at most one session.
    fn start(
        &self,
        spec: LaunchSpec,
        sink: Arc<dyn SessionSink>,
    ) -> BoxFuture<'_, Result<Arc<dyn AgentSession>, Error>>;

    /// The worker's live session, if it has one.
    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>>;

    /// How many sessions are live.
    fn live(&self) -> usize;
}

impl ToolInputDelta {
    pub fn new(call_id: &str, name: &str, phase: ToolInputPhase, text: String) -> Self {
        Self { call_id: call_id.to_owned(), name: name.to_owned(), phase, text }
    }
}
