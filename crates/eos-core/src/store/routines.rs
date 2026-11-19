//! The routine tables: `routines` with `routine_drafts`, `routine_versions`,
//! `routine_sessions` and `routine_spend`.

use eos_contracts::{DraftStatus, RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_domain::run_scope::Trust;

use crate::Error;
use crate::routine::RunRef;

/// A row of `routines`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredRoutine {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub kind: RoutineKind,
    pub state: RoutineState,
    pub paused_reason: Option<String>,
    pub head_version_id: Option<String>,
    /// `architect`, `hand`, `once`, `copy`, `suggestion`, `sync` or `builtin`.
    pub origin: String,
    pub task_key: Option<String>,
    pub agents_may_start: bool,
    pub failure_streak: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// The last change of what syncs.
    pub changed_at: i64,
    pub started_at: Option<i64>,
    pub deleted_at: Option<i64>,
}

/// A row of `routine_drafts`: what a routine's architect works on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDraft {
    pub routine_id: String,
    pub purpose: String,
    pub architect_id: Option<String>,
    pub base_version_id: Option<String>,
    pub draft_version_id: Option<String>,
    pub question: Option<String>,
    pub status: DraftStatus,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A row of `routine_versions`. A version never changes once written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredVersion {
    pub id: String,
    pub routine_id: String,
    pub parent_id: Option<String>,
    pub status: VersionStatus,
    pub author: VersionAuthor,
    pub note: Option<String>,
    pub format: i64,
    /// The blueprint's canonical JSON.
    pub blueprint: String,
    pub hash: String,
    /// Kept without a trial, as the user chose.
    pub no_trial: bool,
    pub trust: Trust,
    pub device: Option<String>,
    pub created_at: i64,
}

/// A row of `routine_sessions`: a session Eos started for a routine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRoutineSession {
    pub worker_id: String,
    pub routine_id: String,
    /// None for the architect.
    pub run_id: Option<String>,
    /// `architect`, `solo`, `lead`, `script`, `specialist` or `checker`.
    pub role: String,
    /// The Who agent it is.
    pub agent_key: Option<String>,
    pub created_at: i64,
}

/// A row of `routine_spend`: what one kind of work for a routine cost on one
/// local day.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredSpend {
    /// `YYYY-MM-DD`, the user's local day.
    pub day: String,
    pub routine_id: String,
    /// `run`, `trial`, `architect`, `intent`, `once` or `suggest`.
    pub kind: String,
    pub cost_usd: f64,
    pub count: i64,
}

pub trait RoutineRepo {
    fn insert(&self, routine: &StoredRoutine) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredRoutine>, Error>;
    /// Every routine, built-in and deleted ones included, oldest first.
    fn list(&self) -> Result<Vec<StoredRoutine>, Error>;
    fn insert_draft(&self, draft: &StoredDraft) -> Result<(), Error>;
    fn draft(&self, routine_id: &str) -> Result<Option<StoredDraft>, Error>;
    /// Writes every column of the routine's draft row but its creation.
    fn update_draft(&self, draft: &StoredDraft) -> Result<(), Error>;
    /// Writes the state and why it is paused (none unless paused).
    fn set_state(&self, id: &str, state: RoutineState, paused_reason: Option<&str>, at: i64) -> Result<(), Error>;
    /// Makes `version_id` the version the routine runs from.
    fn set_head(&self, id: &str, version_id: &str, at: i64) -> Result<(), Error>;
    /// When it went to Recently deleted; `None` when it came back.
    fn set_deleted_at(&self, id: &str, deleted_at: Option<i64>, at: i64) -> Result<(), Error>;
    fn set_kind(&self, id: &str, kind: RoutineKind, at: i64) -> Result<(), Error>;
    /// The name it shows, from the blueprint it runs from.
    fn set_name(&self, id: &str, name: &str, at: i64) -> Result<(), Error>;
}

pub trait RoutineVersionRepo {
    fn insert(&self, version: &StoredVersion) -> Result<(), Error>;
    /// A routine's versions, oldest first: a version's number is its place
    /// here, counted from 1.
    fn list(&self, routine_id: &str) -> Result<Vec<StoredVersion>, Error>;
    fn find(&self, routine_id: &str, id: &str) -> Result<Option<StoredVersion>, Error>;
    /// A draft the user started from: kept, and whether without a trial.
    /// The one change a version row takes.
    fn keep(&self, routine_id: &str, id: &str, no_trial: bool) -> Result<(), Error>;
    /// The version the routine runs from.
    fn head(&self, routine_id: &str) -> Result<Option<StoredVersion>, Error>;
}

pub trait RoutineSessionRepo {
    fn insert(&self, session: &StoredRoutineSession) -> Result<(), Error>;
    /// The routine session a worker is, if it is one.
    fn find(&self, worker_id: &str) -> Result<Option<StoredRoutineSession>, Error>;
    /// A run's sessions, in the order they were written.
    fn by_run(&self, run_id: &str) -> Result<Vec<StoredRoutineSession>, Error>;
    /// The sessions of every run that has not ended.
    fn of_live_runs(&self) -> Result<Vec<StoredRoutineSession>, Error>;
    /// The run the worker works for; `None` for a worker of no run, the
    /// architect's included. Its trust is the version's, or untrusted when
    /// an item of the run is.
    fn run_of(&self, worker_id: &str) -> Result<Option<RunRef>, Error>;
}

pub trait RoutineSpendRepo {
    /// Books `cost_usd` and one more count on a routine's day and kind.
    fn add(&self, day: &str, routine_id: &str, kind: &str, cost_usd: f64) -> Result<(), Error>;
    /// One day's spend, by routine and kind.
    fn of_day(&self, day: &str) -> Result<Vec<StoredSpend>, Error>;
}
