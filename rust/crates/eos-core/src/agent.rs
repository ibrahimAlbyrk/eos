//! Ports over the agent engine: sessions, models, usage
//! (`core/src/ports/AgentBackend.ts`, `ModelCatalog.ts`, …).
//!
//! - [`AgentRuntime`] / [`AgentSession`] / [`SessionSink`]: starting sessions,
//!   driving them, and where they report.
//! - [`BackendDescriptor`] / [`AgentCapabilities`]: what a backend is and can
//!   do. Branch on these, never on a backend's name.
//! - [`PromptAssembler`], [`ToolSets`] / [`HostTool`], [`UserQuestions`]: what
//!   the engine asks of the rest of Eos.

mod descriptor;
mod host;
mod session;

pub use descriptor::{AgentCapabilities, BackendAuth, BackendDescriptor, ModelSource};
pub use host::{HostTool, PromptAssembler, ToolCaller, ToolDefinition, ToolImage, ToolReply, ToolSets, UserQuestions};
pub use session::{
    AgentRuntime, AgentSession, BackgroundTaskKind, BackgroundTaskUpdate, LaunchSpec, Rewound, SessionError,
    SessionSink, SessionTranscript, TaskOutcome, TranscriptEntry,
};

use eos_contracts::{CatalogModel, UiBackendDescriptor};
use serde::{Deserialize, Serialize};

/// The models the provider offers, as last fetched.
pub trait ModelCatalog: Send + Sync + 'static {
    /// The cached list; empty before the first fetch.
    fn models(&self) -> Vec<CatalogModel>;
    /// The model's context window in tokens. Never blocks: the cached list,
    /// else the built-in baseline (`eos_domain::model`).
    fn context_window_for(&self, model: Option<&str>) -> i64;
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
