//! Ports for permission decisions: the gate every tool call passes, and the
//! policy file behind it (`core/src/ports/PolicyGateway.ts`, the YAML loader).

use eos_contracts::{ExternalDecision, UnknownRecord};
use serde_json::Value;

use crate::{BoxFuture, Error};

/// One tool call to decide.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub worker_id: String,
    pub tool_name: String,
    pub input: UnknownRecord,
    /// The model's id for the call; kept on the pending row of an ask.
    pub tool_use_id: Option<String>,
    /// Set when a subagent of the worker makes the call: Eos's control tools
    /// are for the main agent only.
    pub agent_id: Option<String>,
    /// A focused session: the built-ins blocked everywhere else stay open.
    pub full_surface: bool,
}

impl ToolCall {
    pub fn new(worker_id: impl Into<String>, tool_name: impl Into<String>, input: UnknownRecord) -> Self {
        Self {
            worker_id: worker_id.into(),
            tool_name: tool_name.into(),
            input,
            tool_use_id: None,
            agent_id: None,
            full_surface: false,
        }
    }
}

/// What the session layer asks before every tool call. The answer is final:
/// a call the policy leaves to the user waits here until the user decides
/// (it never times out) or the worker ends. An allow carries the input to
/// run with, which a rewrite rule or the user may have changed.
pub trait PolicyDecider: Send + Sync + 'static {
    fn decide(&self, call: ToolCall) -> BoxFuture<'_, Result<ExternalDecision, Error>>;
}

/// How many calls were allowed, denied and left to the user since start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DecisionCounts {
    pub allow: u64,
    pub deny: u64,
    pub ask: u64,
}

/// The decision counters, for the metrics page.
pub trait DecisionCounter: Send + Sync + 'static {
    fn decision_counts(&self) -> DecisionCounts;
}

/// What reading the policy in force found.
#[derive(Debug, Clone, PartialEq)]
pub enum PolicyDocument {
    /// No policy file anywhere.
    Missing,
    /// The first file found does not parse; `source` names it.
    Unreadable { source: String, error: String },
    /// The first file found, as data (mapping keys are strings).
    Parsed { source: String, value: Value },
}

/// `policy.yaml`: the user's file in the data folder, with the bundled
/// example behind it.
pub trait PolicyFile: Send + Sync + 'static {
    /// The policy in force: the user's file when it exists, else the bundled one.
    fn load(&self) -> PolicyDocument;
    /// The user's own file as data; `None` when it does not exist or is empty.
    /// Fails when it does not parse.
    fn read_user(&self) -> Result<Option<Value>, Error>;
    /// Replaces the user's file.
    fn write_user(&self, document: &Value) -> Result<(), Error>;
}
