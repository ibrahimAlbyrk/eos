//! A call of one capability action, what it answers, and how it fails.

use std::fmt;

use eos_contracts::ActionClass;
use eos_domain::capability::health::{HealthState, StateCode};
use serde_json::Value;

use crate::{BoxFuture, Error};

/// One call of an action. The input is the caller's: never logged.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionCall {
    pub capability: String,
    pub action: String,
    pub input: Value,
    pub caller: ActionCaller,
    /// Lets a service that can tell a repeated send find the first one.
    pub idempotency_key: Option<String>,
}

/// Who calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionCaller {
    /// An agent, through `call_capability`.
    Agent { worker_id: String },
    /// A routine run's delivery, after the gate.
    Delivery { run_id: String, delivery_id: String },
    /// A signal source's poll.
    Source,
    /// The dashboard's list of items to pick.
    Candidates,
    /// A health check.
    Health,
    /// A surface's direct action; it may only read.
    Surface { id: String },
    /// Adding push to a source: the action that registers a webhook gets the
    /// secret it signs with, as its `webhook` secret. No other caller has it.
    Push { secret: PushSecret },
}

/// The name the signing secret has in the call that registers a webhook.
pub const WEBHOOK_SECRET: &str = "webhook";

/// A webhook's signing secret, handed to the one call that registers it.
#[derive(Clone, PartialEq, Eq)]
pub struct PushSecret(pub zeroize::Zeroizing<String>);

impl fmt::Debug for PushSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PushSecret")
    }
}

impl ActionCaller {
    /// The word `capability_calls.caller_kind` keeps.
    pub fn kind(&self) -> &'static str {
        match self {
            ActionCaller::Agent { .. } => "agent",
            ActionCaller::Delivery { .. } => "delivery",
            ActionCaller::Source => "source",
            ActionCaller::Candidates => "candidates",
            ActionCaller::Health => "health",
            ActionCaller::Surface { .. } => "surface",
            ActionCaller::Push { .. } => "push",
        }
    }

    /// Whether a model reads the answer.
    pub fn is_model(&self) -> bool {
        matches!(self, ActionCaller::Agent { .. })
    }
}

/// What an action answered: its output with every secret of the capability
/// cut out and the text from outside marked as such. Never logged.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionResult {
    /// The `capability_calls` row's id.
    pub call_id: String,
    pub output: Value,
}

/// Why a call failed in a way the service named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailureKind {
    /// The service refused the sign-in (401, a revoked token).
    Unauthorized,
    /// The service refused the input (422).
    Validation,
    /// The service does not let this account do it there, whatever the
    /// input (GitHub: approving one's own pull request). Trying again does
    /// not help.
    NotAllowed,
    /// The user has a draft of their own where this would go (a pending
    /// GitHub review); it is left alone.
    UserDraftInProgress,
    /// What the input names is not there, or no longer (404).
    Gone,
    /// The service failed, or could not be reached.
    Service,
    /// The answer broke the action's declared output.
    Output,
    /// The capability's code failed in its own way.
    Code,
    /// Eos could not complete the call (its database).
    Internal,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FailureKind::Unauthorized => "unauthorized",
            FailureKind::Validation => "validation",
            FailureKind::NotAllowed => "not_allowed",
            FailureKind::UserDraftInProgress => "user_draft_in_progress",
            FailureKind::Gone => "gone",
            FailureKind::Service => "service",
            FailureKind::Output => "output",
            FailureKind::Code => "code",
            FailureKind::Internal => "internal",
        }
    }

    fn reads(self) -> &'static str {
        match self {
            FailureKind::Unauthorized => "the service refused the sign-in",
            FailureKind::Validation => "the service refused the input",
            FailureKind::NotAllowed => "the service does not let this account do that here",
            FailureKind::UserDraftInProgress => "the user has a draft of their own in the way, left as it is",
            FailureKind::Gone => "what it names is not there",
            FailureKind::Service => "the service failed or could not be reached",
            FailureKind::Output => "its answer did not have the shape it declares",
            FailureKind::Code => "its code failed",
            FailureKind::Internal => "Eos could not complete the call",
        }
    }
}

/// How a call fails. Each kind reads one fixed text to a model
/// ([`fmt::Display`]); only `Invalid` carries the input's issues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    /// No such capability, or no such action of it.
    NotFound,
    /// The caller may not call the action.
    NotGranted,
    /// The input broke the action's schema: `Input validation error: …`.
    Invalid(String),
    /// The capability does not take calls now; its state code, or its state
    /// when it has none (`secret_missing:token`, `disabled`).
    NotReady(String),
    /// Too many calls wait for it already.
    Busy,
    Timeout,
    RateLimited {
        retry_after_s: u64,
    },
    Failed {
        kind: FailureKind,
    },
}

impl ActionError {
    /// The state a capability refuses calls in, with the code it is there for.
    pub fn not_ready(state: HealthState, code: Option<&StateCode>) -> ActionError {
        ActionError::NotReady(code.map_or_else(|| state.as_str().to_owned(), StateCode::as_string))
    }

    /// The word `capability_calls.error_kind` keeps and the log shows.
    pub fn kind(&self) -> &'static str {
        match self {
            ActionError::NotFound => "not_found",
            ActionError::NotGranted => "not_granted",
            ActionError::Invalid(_) => "invalid",
            ActionError::NotReady(_) => "not_ready",
            ActionError::Busy => "busy",
            ActionError::Timeout => "timeout",
            ActionError::RateLimited { .. } => "rate_limited",
            ActionError::Failed { kind } => kind.as_str(),
        }
    }

    /// The word `capability_calls.outcome` keeps.
    pub fn outcome(&self) -> &'static str {
        match self {
            ActionError::NotGranted => "denied",
            ActionError::Timeout => "timeout",
            ActionError::Busy => "busy",
            _ => "error",
        }
    }
}

impl fmt::Display for ActionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ActionError::NotFound => {
                f.write_str("No such capability or action. Call list_capabilities to see what you can use.")
            }
            ActionError::NotGranted => f.write_str("This action is not granted to you here."),
            ActionError::Invalid(issues) => f.write_str(issues),
            ActionError::NotReady(code) => {
                write!(f, "This capability is not ready ({code}). Call list_capabilities to see what the user must do.")
            }
            ActionError::Busy => f.write_str("This capability is busy. Try again in a moment."),
            ActionError::Timeout => f.write_str("The action did not finish in time."),
            ActionError::RateLimited { retry_after_s } => {
                write!(f, "The service is limiting requests. Try again in {retry_after_s} s.")
            }
            ActionError::Failed { kind } => write!(f, "The action failed: {}.", kind.reads()),
        }
    }
}

/// What an agent is told of one capability it may call.
#[derive(Debug, Clone, PartialEq)]
pub struct CapabilityDescription {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub state: HealthState,
    pub state_code: Option<StateCode>,
    /// What the user does to make it work, when it does not.
    pub setup: Option<String>,
    /// The actions granted to the caller.
    pub actions: Vec<ActionDescription>,
    /// The package's instructions; only when one capability was asked for.
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionDescription {
    pub name: String,
    pub summary: String,
    pub class: ActionClass,
    /// The input schema; only when one capability was asked for.
    pub input: Option<Value>,
}

/// Calling capability actions, and telling an agent what it may call.
pub trait CapabilityCalls: Send + Sync {
    /// Runs one call through the registry, grants, state, schemas and
    /// limits, and records it.
    fn call(&self, call: ActionCall) -> BoxFuture<'_, Result<ActionResult, ActionError>>;
    /// The capabilities granted to `worker_id`, with what is missing for
    /// those that do not work; with `id`, that one only, with its input
    /// schemas and instructions.
    fn describe<'a>(
        &'a self,
        worker_id: &'a str,
        id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<CapabilityDescription>, Error>>;
}
