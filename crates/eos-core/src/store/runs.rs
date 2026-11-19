//! The run tables: `runs` with its timeline `run_events`, and `run_results`.

use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};

use crate::Error;
use crate::routine::{FinishedRun, RoutineLoad};

/// A run keeps at most this many timeline events.
pub const RUN_EVENTS_MAX: i64 = 500;

/// The kind of the timeline event a state change writes. The cap never drops
/// one.
pub const RUN_STATE_EVENT: &str = "state";

/// A row of `runs`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredRun {
    pub id: String,
    pub routine_id: String,
    /// The version it runs from, bound when it leaves the queue.
    pub version_id: Option<String>,
    /// `standing`, `project`, `once`, `trial`, `design`, `app-build` or `ask`.
    pub kind: String,
    /// `hand`, `trigger`, `routine`, `agent`, `again`, `trial`, `replay` or
    /// `surface`.
    pub origin: String,
    /// What the origin names: a signal, a run, a worker.
    pub origin_ref: Option<String>,
    /// Where the user started it, for a run by hand.
    pub door: Option<String>,
    /// The run's `RunInput` as JSON.
    pub input: String,
    pub item_key: Option<String>,
    pub state: RunState,
    pub station: Option<Station>,
    pub reason: Option<Reason>,
    /// The check round, from 1.
    pub attempt: i64,
    /// How often it picked up again after Eos stopped.
    pub resumed: i64,
    pub not_before: Option<i64>,
    /// Lower starts first.
    pub priority: i64,
    pub progress_done: Option<i64>,
    pub progress_total: Option<i64>,
    pub headline: Option<String>,
    pub outcome: Option<Outcome>,
    pub cost_usd: f64,
    pub work_ms: i64,
    pub lead_id: Option<String>,
    /// The Mac that runs it.
    pub device: String,
    /// Started from another Mac.
    pub remote: bool,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub updated_at: i64,
}

/// How many of a routine's runs were made since a time, and how many have not
/// ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunCounts {
    pub since: i64,
    pub live: i64,
}

/// A row of `run_events`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRunEvent {
    pub id: i64,
    pub run_id: String,
    pub at: i64,
    pub kind: String,
    /// JSON of ids, states and counts; never outside text.
    pub data: Option<String>,
}

/// A row of `run_results`: what one round of a run submitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRunResult {
    pub run_id: String,
    pub attempt: i64,
    pub kind: String,
    pub headline: String,
    pub body: String,
    /// The result's files as JSON.
    pub files: Option<String>,
    /// The check's verdict as JSON.
    pub verdict: Option<String>,
    pub created_at: i64,
}

/// A run's move to another state, as the engine writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunMove {
    pub state: RunState,
    pub station: Option<Station>,
    pub reason: Option<Reason>,
    pub at: i64,
}

pub trait RunRepo {
    fn insert(&self, run: &StoredRun) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredRun>, Error>;
    /// A routine's newest `limit` runs, newest first.
    fn by_routine(&self, routine_id: &str, limit: i64) -> Result<Vec<StoredRun>, Error>;
    /// Runs made before `before`, of one routine and in one state when
    /// given, newest first, at most `limit`.
    fn page(
        &self,
        routine_id: Option<&str>,
        state: Option<RunState>,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredRun>, Error>;
    /// How many of a routine's runs were made at or after `since`, and how
    /// many have not ended.
    fn counts(&self, routine_id: &str, since: i64) -> Result<RunCounts, Error>;
    /// Adds an event to a run's timeline. Past [`RUN_EVENTS_MAX`] events,
    /// its oldest ones go, never a state change.
    fn append_event(&self, run_id: &str, at: i64, kind: &str, data: Option<&str>) -> Result<(), Error>;
    /// A run's timeline, oldest first.
    fn events(&self, run_id: &str) -> Result<Vec<StoredRunEvent>, Error>;
    /// Moves the run and adds the move to its timeline as a
    /// [`RUN_STATE_EVENT`] (`{state, station?, reason?}`). Its first move to
    /// `running` stamps `started_at`, a move to an end `ended_at`. Answers
    /// the event's id; whether the move is allowed is the caller's question
    /// (`RunState::can_become`).
    fn move_to(&self, id: &str, change: &RunMove) -> Result<i64, Error>;
    /// The version the run runs from, bound when it leaves the queue.
    fn bind_version(&self, id: &str, version_id: &str) -> Result<(), Error>;
    /// The worker that leads it.
    fn set_lead(&self, id: &str, worker_id: &str) -> Result<(), Error>;
    /// What became of its result.
    fn set_outcome(&self, id: &str, outcome: Outcome) -> Result<(), Error>;
    /// The check round it is in, from 1.
    fn set_attempt(&self, id: &str, attempt: i64) -> Result<(), Error>;
    /// The line the user reads first: its result's, or why it failed.
    fn set_headline(&self, id: &str, headline: &str) -> Result<(), Error>;
    /// Every queued run, the one to start first first: by priority, then
    /// age.
    fn queued(&self) -> Result<Vec<StoredRun>, Error>;
    /// Every run that is running or checking.
    fn at_work(&self) -> Result<Vec<StoredRun>, Error>;
    /// How often it was picked up again after Eos stopped.
    fn set_resumed(&self, id: &str, resumed: i64) -> Result<(), Error>;
    /// What it cost and how long its agents worked, as recounted.
    fn set_spent(&self, id: &str, cost_usd: f64, work_ms: i64) -> Result<(), Error>;
    /// Runs whose agents work (running, checking, delivering), by routine.
    fn working(&self) -> Result<Vec<(String, i64)>, Error>;
    /// A routine's runs of one item, newest first.
    fn by_item(&self, routine_id: &str, item_key: &str) -> Result<Vec<StoredRun>, Error>;
    /// Runs whose agents work (running, checking, delivering), and runs
    /// that wait on the user (waiting for the user): what `runs:active`
    /// says.
    fn active(&self) -> Result<(i64, i64), Error>;
    /// Every routine's queued runs.
    fn queued_count(&self) -> Result<i64, Error>;
    fn load(&self, routine_id: &str, since: i64) -> Result<RoutineLoad, Error>;
    /// A routine's runs whose last state change, an end, has an event id
    /// above `after_seq`, in that order.
    fn finished_after(&self, routine_id: &str, after_seq: i64, limit: i64) -> Result<Vec<FinishedRun>, Error>;
}

pub trait RunResultRepo {
    /// One round's result. A round the user reopened (a message during its
    /// check, or its result sent back from the gate) is handed in again:
    /// the new result replaces the round's earlier one and its verdict.
    fn insert(&self, result: &StoredRunResult) -> Result<(), Error>;
    /// A run's results, first round first.
    fn by_run(&self, run_id: &str) -> Result<Vec<StoredRunResult>, Error>;
    /// The check's verdict on one round's result, as JSON.
    fn set_verdict(&self, run_id: &str, attempt: i64, verdict: &str) -> Result<(), Error>;
}
