//! Running agent sessions.
//!
//! A runtime starts sessions; a session is one live conversation of one
//! worker. Everything a session reports goes to the [`SessionSink`] it was
//! started with, in order. Callers gate on the session's
//! [`capabilities`](AgentSession::capabilities) before an optional operation;
//! a session that cannot do it answers [`SessionError::Unsupported`].

use std::sync::Arc;

use eos_contracts::{
    AgentEvent, CommandItem, CompactionTrigger, RewindMode, RewindTarget, SessionFactsRole, WorkflowRunProgress,
};

use super::descriptor::{AgentCapabilities, BackendDescriptor};
use super::{ToolInputDelta, ToolInputPhase};
use crate::accounts::{AfterMove, SessionCredential};
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
    /// The context size, in tokens, at which the session summarizes its
    /// conversation by itself and carries on from the summary. `None`: only
    /// on `/compact`.
    pub compact_at: Option<u64>,
    /// Notes for the model, taken with the first request as
    /// [`AgentSession::note`] takes one.
    pub notes: Vec<String>,
    /// Connect the MCP servers Claude Code's settings configure for its
    /// folder (user, project and local ones), when the runtime connects
    /// them at all (`EngineOptions::mcp` in `eos-engine`); `false` connects
    /// none of them.
    pub folder_mcp: bool,
}

/// A turn about to start, for the notes features put in front of the model
/// with it ([`LaunchSpec::notes`] at a start, [`AgentSession::note`] before a
/// message).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteTurn {
    pub worker_id: String,
    /// What the user (or the parent agent) says; never logged.
    pub message: Option<String>,
    /// The session starts with this turn.
    pub start: bool,
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
            compact_at: None,
            notes: Vec::new(),
            folder_mcp: true,
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
    /// The task to stop has already ended, or the session has no task by
    /// that id; the text says which.
    #[error("{0}")]
    TaskEnded(String),
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
    /// A monitor told its agent of new lines (one batch), or added a notice
    /// of its own (lines dropped, a timeout).
    Event { task_id: String, text: String },
    Ended {
        task_id: String,
        outcome: TaskOutcome,
        summary: Option<String>,
        output_file: Option<String>,
        exit_code: Option<i64>,
    },
}

/// A session summarizing its conversation to free up context. One run is a
/// `Started`, then a `Completed` or a `Failed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionNotice {
    Started {
        trigger: CompactionTrigger,
        /// The context in use when it started.
        before_tokens: i64,
        /// What the user typed after `/compact`.
        instructions: Option<String>,
    },
    /// The conversation now goes on from `summary`.
    Completed {
        trigger: CompactionTrigger,
        before_tokens: i64,
        /// The size of what the conversation now opens with (an estimate).
        after_tokens: i64,
        /// How many of the user's prompts the summary condensed.
        turns: i64,
        summary: String,
        instructions: Option<String>,
        duration_ms: i64,
    },
    /// The conversation is as it was.
    Failed { trigger: CompactionTrigger, error: String },
}

/// The words of a summary: the request the model writes it for, and the
/// message the conversation goes on from.
pub trait CompactionWords: Send + Sync + 'static {
    /// The request; `focus` is what the user typed after `/compact`.
    fn instruction(&self, focus: Option<&str>) -> String;

    /// What the conversation continues from: the `summary`, and the files the
    /// earlier conversation is kept in (`transcript_archive`, a glob).
    fn seed(&self, summary: &str, transcript_archive: &str) -> String;
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

    /// The session summarized its conversation, or began or failed to.
    /// Comes in order with [`events`](Self::events).
    fn compaction<'a>(&'a self, _worker_id: &'a str, _notice: CompactionNotice) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

/// One live session.
pub trait AgentSession: Send + Sync + 'static {
    fn worker_id(&self) -> &str;
    fn capabilities(&self) -> &AgentCapabilities;
    fn is_alive(&self) -> bool;

    /// Delivers a message as a new turn. Resolves when the session has taken
    /// it, not when the turn ends (that arrives as a `turn` event).
    fn send(&self, text: String) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Leaves a note for the session's own agent, sent as given ahead of its
    /// next model request, mid-turn included; a subagent never takes it. It
    /// starts no turn: an idle session takes it with its next turn, which a
    /// [`send`](Self::send) or the session's own background work starts.
    fn note(&self, text: String) -> Result<(), SessionError>;

    /// Stops the running turn; background work of the session goes on.
    fn interrupt(&self) -> BoxFuture<'_, ()>;

    /// Ends the session and its running turn. The sink hears `exited(143)`.
    /// Does nothing on a session that is already over.
    fn stop(&self) -> BoxFuture<'_, ()>;

    /// Runs later turns on `model` (and `effort`, when given), summarizing
    /// by itself at `compact_at` from then on (`None`: never). A model of another provider
    /// moves the conversation there, on the credential a new session of
    /// that provider would start on; a conversation too long for the model
    /// is summarized first.
    fn set_model<'a>(
        &'a self,
        model: &'a str,
        effort: Option<&'a str>,
        compact_at: Option<u64>,
    ) -> BoxFuture<'a, Result<(), SessionError>>;

    /// Summarizes by itself at `compact_at` from the next turn on (`None`:
    /// never); resolves once that holds, after any running turn.
    fn set_compact_at(&self, compact_at: Option<u64>) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Starts over with an empty conversation (`/clear`).
    fn clear_context(&self) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Summarizes the conversation now (`/compact`), after any running turn;
    /// resolves once it is over. How it went reaches the sink as
    /// [`CompactionNotice`]s.
    fn compact(&self, instructions: Option<String>) -> BoxFuture<'_, Result<(), SessionError>>;

    /// The user's earlier prompts a rewind can go back to, oldest first.
    fn rewind_targets(&self) -> BoxFuture<'_, Result<Vec<RewindTarget>, SessionError>>;

    /// Cuts the conversation back to just before the prompt `uuid`.
    fn rewind<'a>(&'a self, uuid: &'a str, mode: RewindMode) -> BoxFuture<'a, Result<Rewound, SessionError>>;

    /// Takes back the last prompt, which the agent has not answered: it
    /// reaches neither the next turn nor a later resume.
    fn recall_last_user_turn(&self) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Background subagents and workflow runs still running in it. They
    /// end when the session does.
    fn live_subagents(&self) -> usize;

    /// Stops one background task (a command, a monitor, a workflow run) or a
    /// subagent (by its agent id); the task's own end event closes it.
    /// [`SessionError::TaskEnded`] when it has already ended.
    fn stop_task<'a>(&'a self, task_id: &'a str) -> BoxFuture<'a, Result<(), SessionError>>;

    /// Answers a question from the conversation as it stands, without
    /// touching it. Dropping the future cancels the question.
    fn ask_side(&self, question: String) -> BoxFuture<'_, Result<String, SessionError>>;

    /// Moves the session to another credential.
    fn switch_account(
        &self,
        credential: SessionCredential,
        after: AfterMove,
    ) -> BoxFuture<'_, Result<(), SessionError>>;

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

    /// The context window, in tokens, of a model the runtime runs on a
    /// provider of its own, outside the model catalog (`None`: it runs no
    /// such model).
    fn other_provider_window(&self, _model: &str) -> Option<i64> {
        None
    }

    /// A session can be put on `model` now, a model of a provider outside
    /// the model catalog.
    fn runs_other_model(&self, model: &str) -> bool {
        self.other_provider_window(model).is_some()
    }

    /// Deletes the conversation recorded for a worker that is gone for good.
    fn forget<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()>;
}

impl ToolInputDelta {
    pub fn new(call_id: &str, name: &str, phase: ToolInputPhase, text: String) -> Self {
        Self { call_id: call_id.to_owned(), name: name.to_owned(), phase, text }
    }
}
