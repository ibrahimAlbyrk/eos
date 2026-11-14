//! Ports over the agent engine: sessions, models, usage.
//!
//! - [`AgentRuntime`] / [`AgentSession`] / [`SessionSink`]: starting sessions,
//!   driving them, and where they report.
//! - [`BackendDescriptor`] / [`AgentCapabilities`]: what a backend is and can
//!   do. Branch on these, never on a backend's name.
//! - [`PromptAssembler`], [`ToolSets`] / [`HostTool`], [`UserQuestions`]: what
//!   the engine asks of the rest of Eos.
//! - [`OneShot`]: one tool-less request to a model, outside any conversation.
//! - [`WorkerControl`], [`Peers`]: what agents ask of each other through
//!   their tools.

mod control;
mod descriptor;
mod host;
mod oneshot;
mod session;

pub use control::{
    DirectiveSent, KilledWorker, OpenQuestions, PeerAnswered, PeerConsult, Peers, Refused, SessionFolder,
    SpawnedWorker, WorkerControl,
};
pub use descriptor::{AgentCapabilities, BackendAuth, BackendDescriptor, ModelSource};
pub use host::{
    FileStamp, HostTool, PromptAssembler, ScratchFolders, SpawnFacts, ToolCaller, ToolDefinition, ToolImage, ToolReply,
    ToolSets, UserMessage, UserMessages, UserNotifier, UserQuestions, WorkerSessions, WorkflowRunFiles,
};
pub use oneshot::{OneShot, OneShotAnswer, OneShotError, OneShotRequest};
pub use session::{
    AgentRuntime, AgentSession, BackgroundTaskKind, BackgroundTaskUpdate, LaunchSpec, Rewound, SessionError,
    SessionSink, SessionTranscript, TaskOutcome, TranscriptEntry,
};

use std::path::Path;

use eos_contracts::{CatalogModel, CommandItem, UiBackendDescriptor};
use serde::{Deserialize, Serialize};

/// The models the provider offers, as last fetched.
pub trait ModelCatalog: Send + Sync + 'static {
    /// The cached list; empty before the first fetch.
    fn models(&self) -> Vec<CatalogModel>;
    /// The model's context window in tokens. Never blocks: the cached list,
    /// else the built-in baseline (`eos_domain::model`).
    fn context_window_for(&self, model: Option<&str>) -> i64;
    /// Fetches the list again unless it was fetched under a minute ago (the
    /// app opening, the model menu opening), then answers the cached list: a
    /// fetch that fails keeps the last one.
    fn refresh_now(&self) -> crate::BoxFuture<'_, Vec<CatalogModel>> {
        Box::pin(std::future::ready(self.models()))
    }
}

/// The provider's own list of its models (`GET /v1/models`).
pub trait ModelsApi: Send + Sync + 'static {
    /// `Err`: why there is none (no sign-in, offline, an answer it cannot read).
    fn list(&self) -> crate::BoxFuture<'_, Result<Vec<CatalogModel>, String>>;
}

/// The skills and slash commands a user can type in a chat, as the composer's
/// menu lists them before any session runs: the folder's own, the user's,
/// the plugins', and (with a folder) the engine's bundled ones. A name given
/// twice is listed once, the folder's first.
pub trait CommandCatalog: Send + Sync + 'static {
    fn commands<'a>(&'a self, cwd: Option<&'a Path>) -> crate::BoxFuture<'a, Vec<CommandItem>>;
}

/// The agent backends this build can run sessions on, as the dashboard's
/// model picker reads them.
pub trait BackendCatalog: Send + Sync + 'static {
    fn descriptors(&self) -> Vec<UiBackendDescriptor>;
}

/// A tool call's input while the model writes it, for a feature that follows
/// that tool live (a visual answer). Not an agent event: it never reaches the
/// event log or the worker state machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputDelta {
    pub call_id: String,
    /// The tool's name.
    pub name: String,
    pub phase: ToolInputPhase,
    /// The input text this piece adds (empty for `start` and `stop`).
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolInputPhase {
    Start,
    Append,
    Stop,
}
