//! Ports for permission decisions: the gate every tool call passes, and the
//! policy file behind it.

use eos_contracts::{ExternalDecision, PermissionMode, UnknownRecord};
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
    /// A file tool would write outside the agent's working directories (its
    /// folder and the folders added to it). Paths in `input` are absolute.
    pub writes_outside: bool,
    /// For a subagent whose chain declares permission modes: the mode its
    /// calls are decided in. `None`: the worker's mode.
    pub subagent: Option<SubagentModes>,
}

/// The mode one call is decided in. A worker runs in accept edits or full
/// access; a subagent may run narrower (see [`SubagentModes`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AgentMode {
    /// Looks only: every call that would change something is denied.
    Plan,
    /// What would be asked is denied instead.
    DontAsk,
    /// Reads pass; file edits are asked, as everything else.
    Default,
    AcceptEdits,
    FullAccess,
}

impl From<PermissionMode> for AgentMode {
    fn from(mode: PermissionMode) -> Self {
        match mode {
            PermissionMode::AcceptEdits => Self::AcceptEdits,
            PermissionMode::BypassPermissions => Self::FullAccess,
        }
    }
}

/// What the permission modes a subagent's chain declares resolve to, for
/// each mode its worker may be in when the call is decided (the user can
/// switch it meanwhile).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubagentModes {
    /// The mode under a worker in accept edits.
    pub accept_edits: AgentMode,
    /// The mode under a worker in full access.
    pub full_access: AgentMode,
    /// The call only looks (what a plan-mode agent may still do).
    pub looks_only: bool,
}

impl SubagentModes {
    /// The mode under a worker in `worker`: never wider than the worker's.
    pub fn under(&self, worker: PermissionMode) -> AgentMode {
        let resolved = match worker {
            PermissionMode::AcceptEdits => self.accept_edits,
            PermissionMode::BypassPermissions => self.full_access,
        };
        resolved.min(AgentMode::from(worker))
    }
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
            writes_outside: false,
            subagent: None,
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
