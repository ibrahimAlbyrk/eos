//! Clearing old routine history (01 G6, G11): runs past what a routine
//! keeps, and routines that leave for good. A run that has not ended (one
//! waiting for the user included) is never touched.

use eos_contracts::RoutineState;

use crate::Error;

/// A run that may go, with the key the next page starts after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndedRun {
    pub id: String,
    pub routine_id: String,
    pub ended_at: i64,
}

/// A routine that leaves for good, and the state it leaves from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeavingRoutine {
    pub id: String,
    pub name: String,
    pub state: RoutineState,
}

/// When routines leave for good: each one with no run that has not ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leaving {
    /// Deleted at or before this.
    pub deleted_by: i64,
    /// A one-off whose last run ended at or before this.
    pub once_by: i64,
    /// A routine never started whose draft was left at or before this.
    pub draft_by: i64,
}

pub trait RoutineRetentionRepo {
    /// Up to `limit` ended runs, by end then id after `after`, that are not
    /// among their routine's newest `keep` runs and ended at or before
    /// `ended_by`.
    fn runs_past(
        &self,
        keep: i64,
        ended_by: i64,
        after: Option<(i64, &str)>,
        limit: i64,
    ) -> Result<Vec<EndedRun>, Error>;
    /// Deletes these runs with their events, results and sessions, and their
    /// deliveries, edits and outcomes; outcomes of their routine's first week
    /// from its start stay, as its baseline. How many runs.
    fn delete_runs(&self, ids: &[String]) -> Result<usize, Error>;
    /// Up to `limit` workers, by id after `after`, of sessions of runs that
    /// ended at or before `ended_by` whose worker is still there.
    fn transcripts_past(&self, ended_by: i64, after: &str, limit: i64) -> Result<Vec<String>, Error>;
    /// Up to `limit` routines that leave for good, by id after `after`.
    fn leaving(&self, when: &Leaving, after: &str, limit: i64) -> Result<Vec<LeavingRoutine>, Error>;
    /// The workers still there of every session of the routine.
    fn workers_of(&self, routine_id: &str) -> Result<Vec<String>, Error>;
    /// Deletes up to `limit` of the routine's runs as [`delete_runs`](Self::delete_runs)
    /// does, its first week's outcomes too; how many.
    fn delete_runs_of(&self, routine_id: &str, limit: i64) -> Result<usize, Error>;
    /// Deletes the routine and every row left of it.
    fn delete_routine(&self, routine_id: &str) -> Result<(), Error>;
}
