//! What routines offer the other areas: starting and stopping runs, which
//! run a worker belongs to, and control over a routine's Freedom and state
//! for the areas that hold or pause it.

use std::path::PathBuf;

use eos_contracts::{Freedom, ItemRef, Recipient, RoutineKind, RoutineState, RunInput, Rung, When, Which};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState};
use eos_domain::run_scope::{RunRole, Trust};

use crate::store::{Outbox, Tx};
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
    /// Where the run keeps what it made, under Eos's data folder
    /// (`routines/<routine>/runs/<run>`).
    pub output_dir: PathBuf,
}

/// Which run a worker belongs to. Inside a write job the same read is
/// `tx.routine_sessions().run_of(worker_id)`.
pub trait RunLookup: Send + Sync {
    /// `None` for a worker of no run: a chat, a routine's architect.
    fn run_of<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<RunRef>>;
}

/// A run a signal starts, as the signals' router admits it inside its own
/// write job.
#[derive(Debug, Clone, PartialEq)]
pub struct Admission {
    pub routine_id: String,
    /// The signal's row id: one signal starts at most one run of a routine.
    pub signal_id: i64,
    pub input: RunInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmitOutcome {
    Queued { run_id: String },
    Refused { reason: AdmitRefusal },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmitRefusal {
    /// The queue holds as many runs as it may.
    QueueFull,
    /// The routine is gone or does not take triggered runs now.
    NotActive,
}

/// A routine's runs as the signals' limits count them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutineLoad {
    /// Waiting in the queue.
    pub queued: i64,
    /// Made at or after the time asked about.
    pub started_since: i64,
    /// Out of the queue and not ended.
    pub active: i64,
}

/// A run that ended, in the order runs ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedRun {
    /// The `run_events` id of its last state change: later runs end higher.
    pub seq: i64,
    pub run_id: String,
    pub state: RunState,
    pub reason: Option<Reason>,
    pub outcome: Option<Outcome>,
    pub ended_at: i64,
}

/// Runs the signals' router starts and counts, inside its own write job, so a
/// signal's decision and its run are saved together.
pub trait RunIntake: Send + Sync {
    fn admit(&self, tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error>;
    /// Skips a queued run a newer signal of the same subject replaces; false
    /// when it has left the queue.
    fn supersede(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<bool, Error>;
    fn load(&self, tx: &dyn Tx, routine_id: &str, since: i64) -> Result<RoutineLoad, Error>;
    /// The routine's runs that ended after the one whose end is `after_seq`,
    /// first ended first, at most `limit`.
    fn finished_after(
        &self,
        tx: &dyn Tx,
        routine_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<FinishedRun>, Error>;
}

/// What starts a routine's runs, from its head version.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutineTriggers {
    pub id: String,
    /// The head version's id.
    pub version: String,
    pub state: RoutineState,
    pub kind: RoutineKind,
    pub when: When,
    pub which: Which,
}

pub trait RoutineDirectory: Send + Sync {
    /// Every routine with a head this app runs, deleted ones left out.
    fn triggers(&self) -> BoxFuture<'_, Result<Vec<RoutineTriggers>, Error>>;
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
    /// [`confirmed`](RoutineControl::confirmed) inside the caller's job.
    fn confirmed_in(&self, tx: &dyn Tx, routine_id: &str) -> Result<Confirmed, Error>;
    /// Gives the routine more freedom, in a version the user authored (an
    /// offer accepted).
    fn raise<'a>(&'a self, routine_id: &'a str, rung: Rung) -> BoxFuture<'a, Result<(), Error>>;
    /// Holds its results as drafts again, in a version Eos authored that
    /// says why.
    fn step_down<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    fn pause<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// [`pause`](RoutineControl::pause) inside the caller's job.
    fn pause_in(&self, tx: &dyn Tx, out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), Error>;
    /// Resumes every routine paused for `reason`.
    fn resume_paused<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routines whose current version needs the capability.
    fn using_capability<'a>(&'a self, capability_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>>;
}
