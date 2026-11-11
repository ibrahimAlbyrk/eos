//! Ports over the agent engine: sessions, models, usage
//! (`core/src/ports/AgentBackend.ts`, `ModelCatalog.ts`, …).

use serde::{Deserialize, Serialize};

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
