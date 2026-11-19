//! What routines offer the other areas: starting and stopping runs, which
//! run a worker belongs to, and control over a routine's Freedom and state
//! for the areas that hold or pause it.

use std::path::PathBuf;

use eos_contracts::{Freedom, ItemRef, Recipient, RoutineState, RunInput, Rung};
use eos_domain::routine::run::{Reason, RunState};
use eos_domain::run_scope::{RunRole, Trust};

use crate::{BoxFuture, Error};

/// Who asked for a run. Each origin is checked in one place, the start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOrigin {
    /// The user, through a door of Eos.
    Hand,
    /// The user, doing an earlier run again.
    Again { run_id: String },
    /// A trial of a routine being made.
    Trial,
    /// An agent in a chat; only when the routine lets agents start it.
    Agent { worker_id: String },
    /// Another routine's run; only when this routine's When names it.
    Routine { run_id: String },
}

impl RunOrigin {
    /// The word `runs.origin` stores.
    pub fn word(&self) -> &'static str {
        match self {
            RunOrigin::Hand => "hand",
            RunOrigin::Again { .. } => "again",
            RunOrigin::Trial => "trial",
            RunOrigin::Agent { .. } => "agent",
            RunOrigin::Routine { .. } => "routine",
        }
    }

    /// What `runs.origin_ref` names: the earlier run, the worker, the run
    /// upstream.
    pub fn reference(&self) -> Option<&str> {
        match self {
            RunOrigin::Hand | RunOrigin::Trial => None,
            RunOrigin::Again { run_id } | RunOrigin::Routine { run_id } => Some(run_id),
            RunOrigin::Agent { worker_id } => Some(worker_id),
        }
    }
}

/// One start: one run, or one run per item of `items`.
#[derive(Debug, Clone, PartialEq)]
pub struct NewRun {
    pub routine_id: String,
    pub input: RunInput,
    /// Several items, one run each; empty for one run of `input`.
    pub items: Vec<ItemRef>,
    pub origin: RunOrigin,
    /// Where the user started it.
    pub door: Option<String>,
    /// Start although the routine handled the same item lately.
    pub confirm_repeat: bool,
    /// The same id again, within ten minutes, answers the same runs.
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunCreated {
    pub id: String,
    pub state: RunState,
    pub not_before: Option<i64>,
}

/// Why a start was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// 404.
    UnknownRoutine(String),
    /// 409: the routine handled the item within a day, or handles it now.
    SameItem {
        existing_run_id: String,
    },
    /// 409: the routine's state does not take this start.
    RoutineState(RoutineState),
    /// 400; the text names the field.
    Invalid(String),
    Store(Error),
}

impl From<Error> for StartError {
    fn from(error: Error) -> Self {
        StartError::Store(error)
    }
}

/// Starts and stops runs: every door, the tools and the gateways start
/// through it.
pub trait RunStarter: Send + Sync {
    /// Checks the start and queues its runs in one write; the supervisor
    /// starts them when it may.
    fn start(&self, run: NewRun) -> BoxFuture<'_, Result<Vec<RunCreated>, StartError>>;
    /// Cancels a run that has not ended. A run that is delivering cannot be
    /// stopped (409).
    fn stop<'a>(&'a self, run_id: &'a str, why: Reason) -> BoxFuture<'a, Result<(), Error>>;
}

/// The run a worker works for, and its place in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRef {
    pub run_id: String,
    pub routine_id: String,
    /// The routine's version the run runs from.
    pub version_id: String,
    /// `standing`, `project`, `once`, `trial`, `design`, `app-build` or
    /// `ask`.
    pub kind: String,
    pub role: RunRole,
    /// The agent of the routine's Who it is.
    pub agent_key: Option<String>,
    pub trust: Trust,
    /// What started the run: `hand`, `trigger`, `routine`, `agent`, `again`,
    /// `trial`, `replay` or `surface`.
    pub origin: String,
    pub started_at: i64,
    /// Where the run keeps what it made.
    pub output_dir: PathBuf,
}

/// Which run a worker belongs to.
pub trait RunLookup: Send + Sync {
    /// `None` for a worker of no run: a chat, a routine's architect.
    fn run_of<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<RunRef>>;
}

/// What the user confirmed of a routine: the Freedom and Goes to of its
/// latest version the user wrote or confirmed.
#[derive(Debug, Clone, PartialEq)]
pub struct Confirmed {
    pub freedom: Freedom,
    pub goes_to: Vec<Recipient>,
}

/// Changes to a routine that another area makes. Each change of Freedom is
/// a new version of its blueprint.
pub trait RoutineControl: Send + Sync {
    fn confirmed<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Confirmed, Error>>;
    /// Gives the routine more freedom, in a version the user authored (an
    /// offer accepted).
    fn raise<'a>(&'a self, routine_id: &'a str, rung: Rung) -> BoxFuture<'a, Result<(), Error>>;
    /// Holds its results as drafts again, in a version Eos authored that
    /// says why.
    fn step_down<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    fn pause<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// Resumes every routine paused for `reason`.
    fn resume_paused<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routines whose current version needs the capability.
    fn using_capability<'a>(&'a self, capability_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>>;
}
