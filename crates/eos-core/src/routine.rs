//! What routines offer the other areas: which run a worker belongs to, and
//! control over a routine's Freedom and state for the areas that hold or
//! pause it.

use std::path::PathBuf;

use eos_contracts::{Freedom, Recipient, Rung};
use eos_domain::run_scope::{RunRole, Trust};

use crate::{BoxFuture, Error};

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
