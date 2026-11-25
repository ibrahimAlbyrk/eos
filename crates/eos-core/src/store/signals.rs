//! The signal tables: `signal_sources`, `signals`, `signal_routes`,
//! `signal_schedules` and `signal_runners`. Keys, subjects, scopes and facts
//! are the user's data: never logged.

use eos_domain::routine::run::RunState;
use eos_domain::signals::decision::Decision;

use crate::Error;

/// A row of `signal_sources`: one place signals come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSignalSource {
    pub id: String,
    /// `clock`, `manual`, `capability`, `folder`, `git`, `after` or
    /// `push-inbox`.
    pub kind: String,
    /// A capability's source (`github.pulls`).
    pub source: Option<String>,
    /// The scope as canonical JSON.
    pub scope_json: String,
    /// Names the kind, source and scope: one row serves every routine that
    /// shares them.
    pub scope_hash: String,
    /// The source's own cursor, handed back as it was.
    pub cursor_json: Option<String>,
    /// `active`, `backing-off`, `needs-attention`, `off` or `stopped`.
    pub state: String,
    /// `unreachable`, `unauthorized`, `gone`, `no-access` or `rate-limited`.
    pub error_kind: Option<String>,
    /// Failed polls in a row.
    pub failures: i64,
    pub interval_ms: i64,
    pub last_poll_at: Option<i64>,
    pub next_poll_at: Option<i64>,
    pub last_signal_at: Option<i64>,
    /// `{at, items, gapMs}` of the last poll after a gap of over 15 minutes.
    pub catch_up_json: Option<String>,
    pub stopped_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A signal as its source saw it, before it has a number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSignal {
    pub source_id: String,
    /// Names the thing seen: the same key from the same source is the same
    /// signal.
    pub key: String,
    /// The thing it is about (`github:pr:acme/game#482`).
    pub subject: String,
    /// The subject's version (a pull request's head commit).
    pub version: Option<String>,
    /// What happened, as the source names it.
    pub kind: String,
    pub occurred_at: i64,
    pub received_at: i64,
    /// What rules may test, as JSON.
    pub facts_json: Option<String>,
    /// The item a run of it takes, as JSON.
    pub item_json: String,
    /// How many routines' results led to it.
    pub depth: i64,
}

/// A row of `signals`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSignal {
    /// Arrival order.
    pub id: i64,
    pub signal: NewSignal,
    /// Every routine that could take it has its decision.
    pub routed: bool,
}

/// The scope hash of the one `manual` source every run started by hand is a
/// signal of.
pub const MANUAL_SCOPE_HASH: &str = "manual";

/// A run started by hand, as the signal that started it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualSignal {
    /// The `manual` source.
    pub source_id: String,
    pub run_id: String,
    pub routine_id: String,
    /// The routine's version the run was started on.
    pub routine_version: String,
    pub subject: String,
    pub version: Option<String>,
    /// The run's item, as JSON.
    pub item_json: String,
    pub at: i64,
}

/// A row of `signal_routes`: what became of one signal for one routine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSignalRoute {
    pub signal_id: i64,
    pub routine_id: String,
    /// The routine's version when it was decided.
    pub routine_version: String,
    pub decision: Decision,
    /// A short code, or for `unmatched` the index of the first rule that
    /// failed.
    pub reason: Option<String>,
    pub run_id: Option<String>,
    /// The routine's question went to the model.
    pub model_asked: bool,
    pub decided_at: i64,
}

/// A row of `signal_schedules`: what the scheduler keeps of one schedule of
/// one routine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSignalSchedule {
    pub routine_id: String,
    /// The schedule's place in the routine's When list.
    pub slot: i64,
    /// The schedule as it was armed: another hash arms it again.
    pub spec_hash: String,
    pub zone: String,
    /// No slot before it fires.
    pub armed_at: i64,
    pub last_slot_at: Option<i64>,
    pub next_at: Option<i64>,
    /// Slots that ran as one later slot.
    pub missed: i64,
    /// How late the last slot fired.
    pub late_by_ms: i64,
    pub updated_at: i64,
}

/// A row of `signal_runners`: who holds a routine, as this computer last
/// read it from the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSignalRunner {
    pub routine_id: String,
    pub holder_device: String,
    pub epoch: i64,
    /// The vault's sequence of the lease that was read.
    pub seen_seq: i64,
    pub seen_at: i64,
    /// What the computer it moved from left for it, as JSON.
    pub handoff_json: Option<String>,
}

pub trait SignalSourceRepo {
    fn insert(&self, source: &StoredSignalSource) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredSignalSource>, Error>;
    /// The source with this kind, source and scope.
    fn by_scope(&self, scope_hash: &str) -> Result<Option<StoredSignalSource>, Error>;
    /// Every source, by id.
    fn all(&self) -> Result<Vec<StoredSignalSource>, Error>;
    /// Writes every field of the source with this id but `created_at`.
    fn update(&self, source: &StoredSignalSource) -> Result<(), Error>;
}

pub trait SignalRepo {
    /// Keeps a signal as received. `None`, and nothing written, when its
    /// source has reported its key before.
    fn ingest(&self, signal: &NewSignal) -> Result<Option<i64>, Error>;
    /// Keeps the signal of a run started by hand, key `manual:<run id>`,
    /// routed to its routine as `run`. Called in the job that creates the
    /// run, so the two are saved together.
    fn insert_manual(&self, manual: &ManualSignal) -> Result<i64, Error>;
    fn find(&self, id: i64) -> Result<Option<StoredSignal>, Error>;
    /// The oldest `limit` signals not routed yet numbered after `after`,
    /// oldest first.
    fn received(&self, after: i64, limit: i64) -> Result<Vec<StoredSignal>, Error>;
    fn mark_routed(&self, id: i64) -> Result<(), Error>;
    /// How many signals wait to be routed.
    fn received_count(&self) -> Result<i64, Error>;
    /// Up to `limit` signals older than `before`, newest first: only those
    /// routed to `routine` and only those decided `decision`, when given.
    fn page(
        &self,
        routine: Option<&str>,
        decision: Option<Decision>,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredSignal>, Error>;
}

/// A signal that waits in a routine's open batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchedSignal {
    pub signal_id: i64,
    pub decided_at: i64,
    /// Its item, as JSON.
    pub item_json: String,
}

/// How many of a routine's signals got one decision, by the state of the
/// run they are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalTally {
    pub decision: Decision,
    /// `None` when no run took them, or its run is gone.
    pub run_state: Option<RunState>,
    pub signals: i64,
}

/// What a routine's schedules did in a window: slots that ran as one later
/// slot, and slots that fired late.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlotTally {
    pub missed: i64,
    pub late: i64,
}

pub trait SignalRouteRepo {
    /// Fails when the signal has a decision for the routine already.
    fn insert(&self, route: &StoredSignalRoute) -> Result<(), Error>;
    /// Writes the signal's decision for the routine in place of the one
    /// before, if any.
    fn put(&self, route: &StoredSignalRoute) -> Result<(), Error>;
    /// The routine's signals decided at or after `since`, counted by
    /// decision and run state.
    fn tally(&self, routine_id: &str, since: i64) -> Result<Vec<SignalTally>, Error>;
    /// The routine's schedule slots that fired at or after `since`: the
    /// `missed` facts summed, and those fired over `late_ms` after their
    /// slot counted.
    fn slots(&self, routine_id: &str, since: i64, late_ms: i64) -> Result<SlotTally, Error>;
    /// A signal's decisions, by routine id.
    fn by_signal(&self, signal_id: i64) -> Result<Vec<StoredSignalRoute>, Error>;
    /// The runs the routine's `run` decisions on signals about `subject`
    /// started.
    fn runs_of_subject(&self, routine_id: &str, subject: &str) -> Result<Vec<String>, Error>;
    /// The routine's signals decided `batched` that no run took yet, first
    /// first.
    fn open_batch(&self, routine_id: &str) -> Result<Vec<BatchedSignal>, Error>;
    /// The run that took these batched signals of the routine.
    fn set_run(&self, routine_id: &str, signal_ids: &[i64], run_id: &str) -> Result<(), Error>;
    /// How many of the routine's signals were decided `decision` at or after
    /// `since`.
    fn count_since(&self, routine_id: &str, decision: Decision, since: i64) -> Result<i64, Error>;
}

pub trait SignalScheduleRepo {
    /// Writes a routine's schedule in place of the one in its slot.
    fn put(&self, schedule: &StoredSignalSchedule) -> Result<(), Error>;
    /// A routine's schedules, by slot.
    fn of_routine(&self, routine_id: &str) -> Result<Vec<StoredSignalSchedule>, Error>;
}

pub trait SignalRunnerRepo {
    /// Writes a routine's holder in place of the one before.
    fn put(&self, runner: &StoredSignalRunner) -> Result<(), Error>;
    fn find(&self, routine_id: &str) -> Result<Option<StoredSignalRunner>, Error>;
    /// Every routine's holder, by routine id.
    fn list(&self) -> Result<Vec<StoredSignalRunner>, Error>;
}

/// Clearing old signals (02 §3 I.44). A signal a run that still exists
/// took is kept whole.
pub trait SignalRetentionRepo {
    /// Clears the facts of up to `limit` signals received before `before`;
    /// how many.
    fn clear_facts(&self, before: i64, limit: i64) -> Result<usize, Error>;
    /// Up to `limit` signals received before `before` that no run took,
    /// oldest first.
    fn unrun_before(&self, before: i64, limit: i64) -> Result<Vec<i64>, Error>;
    /// Deletes these signals and their decisions; how many signals.
    fn delete(&self, ids: &[i64]) -> Result<usize, Error>;
    /// How many signals are kept.
    fn count(&self) -> Result<i64, Error>;
    /// Deletes up to `limit` sources stopped before `before`; how many.
    fn delete_stopped_sources(&self, before: i64, limit: i64) -> Result<usize, Error>;
}

/// Which source each hook of the relay's inbox wakes (02 §3 E.29).
pub trait SignalHookRepo {
    fn insert(&self, hook_id: &str, source_id: &str, created_at: i64) -> Result<(), Error>;
    /// The source the hook wakes.
    fn source_of(&self, hook_id: &str) -> Result<Option<String>, Error>;
    /// The sources at least one hook wakes, by id.
    fn hooked(&self) -> Result<Vec<String>, Error>;
}

/// The decisions the model's stage of Which takes.
pub trait SignalAskRepo {
    /// Up to `limit` decisions of `routine_ids` `undecided` for one of
    /// `reasons`: by the place of their reason in `reasons`, then first
    /// decided first.
    fn waiting_asks(&self, routine_ids: &[&str], reasons: &[&str], limit: i64)
    -> Result<Vec<StoredSignalRoute>, Error>;
    /// How many of the routine's signals went to the model at or after
    /// `since`.
    fn asked_since(&self, routine_id: &str, since: i64) -> Result<i64, Error>;
}
