//! What signals come from and who acts on them: a source a capability
//! declares (`SignalSource`), the registry of them (`SignalSources`), and
//! which of the user's computers holds each routine (`Runner`). Keys,
//! subjects, scopes and facts are the user's data: never logged.

use std::sync::Arc;

use eos_contracts::Facts;
use eos_domain::capability::manifest::FactType;
use indexmap::IndexMap;
use serde_json::Value;

use crate::BoxFuture;
use crate::net::hooks::HookUrl;

/// A fact a source gives, which a routine's rules may test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactDecl {
    pub name: String,
    pub kind: FactType,
}

/// Where a source reads: a routine's `scope` (`{"repo": "acme/game"}`).
pub type Scope = IndexMap<String, String>;

#[derive(Debug, Clone, PartialEq)]
pub struct PollRequest {
    pub scope: Scope,
    /// The source's own cursor, handed back as it gave it; none at the
    /// first poll.
    pub cursor: Option<Value>,
    /// How long a long-poll source may hold the call; 0 for a short poll.
    pub wait_ms: u64,
    /// The thing a push named: the poll looks at it first.
    pub focus: Option<String>,
}

/// One page of what a source saw since its cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct PollPage {
    pub items: Vec<SignalDraft>,
    pub cursor: Value,
    /// Another page waits.
    pub more: bool,
    /// The first read of a scope: what exists now is the starting point, not
    /// news.
    pub baseline: bool,
    /// The source asks not to be polled sooner.
    pub poll_after_ms: Option<i64>,
    pub retry_at: Option<i64>,
}

/// A thing a source saw, before it is kept as a signal.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalDraft {
    /// The same key from the same source is the same signal.
    pub key: String,
    /// What it is about (`github:pr:acme/game#482`).
    pub subject: String,
    /// The subject's version (a pull request's head commit).
    pub version: Option<String>,
    /// What happened, as the source names it.
    pub kind: String,
    pub occurred_at: i64,
    pub facts: Facts,
    /// The item a run of it takes.
    pub item: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    Unreachable,
    RateLimited {
        retry_at: i64,
    },
    /// The sign-in no longer works.
    Unauthorized,
    /// What the scope names is gone (a deleted repository).
    Gone,
    /// The source does nothing in this run of Eos.
    Off,
    Bad(&'static str),
}

/// A push the relay's mailbox held, as the service sent it. Never trusted
/// before the source checked its signature.
#[derive(Clone, PartialEq, Eq)]
pub struct PushEvent {
    /// The hook it came through: which secret signs it.
    pub hook: String,
    /// Lower-case names, as the service sent them.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl std::fmt::Debug for PushEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushEvent").field("bytes", &self.body.len()).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PushOutcome {
    /// Poll the source now, looking at `focus` first.
    PollNow { focus: Option<String> },
    /// A source with nothing to poll makes its signal from the push itself.
    Signal(Box<SignalDraft>),
    /// The signature did not check out, or the event is not one it takes.
    Refused,
}

pub trait SignalSource: Send + Sync {
    /// What rules may test.
    fn facts(&self) -> &[FactDecl];
    /// How often the source asks to be polled; `None` when it does not say.
    fn interval_ms(&self) -> Option<i64> {
        None
    }
    /// How long one poll may hold the call waiting for news; 0 for a short
    /// poll.
    fn wait_ms(&self) -> u64 {
        0
    }
    /// Whether an event of kind `kind` ends its subject (a pull request
    /// merged or closed).
    fn closes(&self, _kind: &str) -> bool {
        false
    }
    fn poll(&self, request: PollRequest) -> BoxFuture<'_, Result<PollPage, SourceError>>;
    /// Checks a push's signature: a hint to poll now, a signal (a source
    /// with no list to poll), or refused.
    fn accept_push<'a>(
        &'a self,
        scope: &'a Scope,
        event: &'a PushEvent,
    ) -> BoxFuture<'a, Result<PushOutcome, SourceError>>;
    /// Whether the service can push this source's events.
    fn pushes(&self) -> bool {
        false
    }
    /// Has the service push the scope's events to `hook`: keeps a secret
    /// for it and registers the webhook with the service.
    fn add_push<'a>(&'a self, _scope: &'a Scope, _hook: &'a HookUrl) -> BoxFuture<'a, Result<(), SourceError>> {
        Box::pin(std::future::ready(Err(SourceError::Bad("push"))))
    }
}

/// The sources the capabilities declare, by name (`github.pulls`).
pub trait SignalSources: Send + Sync {
    fn get(&self, source: &str) -> Option<Arc<dyn SignalSource>>;
}

/// Who holds a routine, as this computer last read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    /// This computer, at this epoch.
    Here {
        epoch: i64,
    },
    Elsewhere {
        device_id: String,
        epoch: i64,
    },
    /// No lease was read yet: nothing acts on the routine.
    Unknown,
}

/// What a computer that takes a routine over starts from: the epoch it now
/// holds and what the computer before it had seen.
#[derive(Debug, Clone, PartialEq)]
pub struct Handoff {
    pub routine_id: String,
    pub epoch: i64,
    /// The sources' cursors, their last keys and the schedules' last slots,
    /// as the computer before last reported them.
    pub watermarks: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerError {
    /// The shared record could not be reached.
    Unreachable,
    /// Another computer claimed the routine first.
    Lost { holder: String, epoch: i64 },
    /// This computer lacks a capability a source of the routine needs.
    Missing { capability: String },
    /// Nothing is shared in this run of Eos.
    Off,
}

/// This computer's heartbeat: what it holds and how far it got.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceReport {
    pub name: String,
    pub seen_at: i64,
    pub holds: Vec<HeldRoutine>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeldRoutine {
    pub routine_id: String,
    pub epoch: i64,
    pub watermarks: Value,
    /// Signals per hour, the newest last.
    pub counts: Vec<i64>,
}

/// Another of the user's computers, as its last heartbeat showed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSeen {
    pub device_id: String,
    pub name: String,
    pub seen_at: i64,
    pub routines: Vec<String>,
}

/// Which of the user's computers acts on each routine's triggers.
pub trait Runner: Send + Sync {
    fn device_id(&self) -> &str;
    /// The last confirmed view; never waits.
    fn holder(&self, routine_id: &str) -> Holder;
    /// Holds a routine made here, at its first epoch.
    fn adopt<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), RunnerError>>;
    /// Moves a routine here from whoever holds it.
    fn claim<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Handoff, RunnerError>>;
    fn report<'a>(&'a self, report: &'a DeviceReport) -> BoxFuture<'a, Result<(), RunnerError>>;
    fn devices(&self) -> Vec<DeviceSeen>;
    /// The last successful read of the shared record.
    fn confirmed_at(&self) -> Option<i64>;
    /// Whether the leases are shared with other computers now: while not,
    /// nothing waits for a read of them.
    fn shared(&self) -> bool {
        false
    }
    /// What another computer's last heartbeat said of a routine it holds:
    /// when it was written and the runs decided in each hour before, the
    /// newest last.
    fn hourly_elsewhere(&self, _routine_id: &str) -> Option<(i64, Vec<i64>)> {
        None
    }
}
