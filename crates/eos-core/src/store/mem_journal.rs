//! Memory's journal and bookkeeping: `mem_moments`, `mem_cursors`,
//! `mem_uses`, `mem_stated`, `mem_forgotten`, `mem_settings` and
//! `mem_daily`. Moments hold row ranges and cues, never text; cues and
//! snapshots are the user's data: never logged.

use eos_domain::experience::Trust;

use crate::Error;

/// Done moments are kept this long.
pub const MEM_MOMENTS_DONE_KEPT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Uses are kept this long.
pub const MEM_USES_KEPT_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// A forgotten note can be brought back, and is not learned again, this long.
pub const MEM_FORGOTTEN_KEPT_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// A row of `mem_moments`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredMoment {
    /// `mm-`.
    pub id: String,
    pub worker_id: String,
    /// `agent`, `code` or `run`.
    pub source: String,
    pub run_id: Option<String>,
    /// The signal's name (`says_wrong`, `command_fails`, …).
    pub signal: String,
    pub trust: Trust,
    pub row_from: i64,
    pub row_to: i64,
    /// `[{kind, key}]` as JSON.
    pub cues: String,
    /// `pending`, `reflected`, `skipped` or `failed`.
    pub state: String,
    pub note_id: Option<String>,
    pub attempts: i64,
    pub created_at: i64,
    pub done_at: Option<i64>,
}

/// A row of `mem_uses`: a note that rode in a session or run.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredUse {
    pub id: String,
    pub note_id: String,
    pub worker_id: Option<String>,
    pub run_id: Option<String>,
    /// `pack`, `reminder` or `tool`.
    pub how: String,
    pub epoch: i64,
    pub at: i64,
    /// The agent acted on it.
    pub acted: bool,
    pub outcome: Option<String>,
}

/// A row of `mem_stated`: where a stated rule was said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredStated {
    /// An `um-` (About you) or `mn-` id.
    pub memory_id: String,
    pub worker_id: String,
    pub row_id: i64,
    pub at: i64,
}

/// A row of `mem_forgotten`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredForgotten {
    pub note_id: String,
    /// Hooks and meaning as JSON: what refuses relearning it.
    pub fingerprint: String,
    /// The note as JSON: what brings it back.
    pub snapshot: String,
    pub at: i64,
}

/// A row of `mem_daily`: model calls on one local day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DailyCalls {
    pub classifier: i64,
    pub reflections: i64,
    pub night_calls: i64,
}

/// Which count of [`DailyCalls`] to raise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DailyCall {
    Classifier,
    Reflection,
    Night,
}

pub trait MemMomentRepo {
    fn insert(&self, moment: &StoredMoment) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredMoment>, Error>;
    /// Up to `limit` pending moments: said first, then outcome, did and guess,
    /// each oldest first.
    fn pending(&self, limit: i64) -> Result<Vec<StoredMoment>, Error>;
    fn count_pending(&self) -> Result<i64, Error>;
    /// Ends a moment: `reflected`, `skipped` or `failed`, with the note it made.
    fn finish(&self, id: &str, state: &str, note_id: Option<&str>, at: i64) -> Result<(), Error>;
    /// One more failed try; answers the count.
    fn add_attempt(&self, id: &str) -> Result<i64, Error>;
    /// Pending moments created before `before` become `skipped`; answers how many.
    fn skip_older(&self, before: i64, at: i64) -> Result<usize, Error>;
    /// Deletes done moments finished before `before`; answers how many.
    fn prune_done(&self, before: i64) -> Result<usize, Error>;
    fn clear(&self) -> Result<(), Error>;
}

pub trait MemCursorRepo {
    /// The last row read for `key`.
    fn get(&self, key: &str) -> Result<Option<i64>, Error>;
    fn set(&self, key: &str, last_row: i64, at: i64) -> Result<(), Error>;
    fn delete(&self, key: &str) -> Result<(), Error>;
}

pub trait MemUseRepo {
    fn insert(&self, used: &StoredUse) -> Result<(), Error>;
    /// The uses in a worker's session since an epoch began.
    fn of_worker(&self, worker_id: &str, epoch: i64) -> Result<Vec<StoredUse>, Error>;
    fn of_run(&self, run_id: &str) -> Result<Vec<StoredUse>, Error>;
    /// When a note was used, newest first.
    fn times_of_note(&self, note_id: &str, limit: i64) -> Result<Vec<i64>, Error>;
    fn set_acted(&self, id: &str) -> Result<(), Error>;
    /// Sets the outcome of every use of a worker's session (or a run) that has none.
    fn settle(&self, worker_id: Option<&str>, run_id: Option<&str>, outcome: &str) -> Result<usize, Error>;
    fn prune(&self, before: i64) -> Result<usize, Error>;
    fn clear(&self) -> Result<(), Error>;
}

pub trait MemBookRepo {
    fn put_stated(&self, stated: &StoredStated) -> Result<(), Error>;
    /// Every stated rule's provenance, newest first.
    fn stated(&self) -> Result<Vec<StoredStated>, Error>;

    fn put_forgotten(&self, forgotten: &StoredForgotten) -> Result<(), Error>;
    fn forgotten(&self, note_id: &str) -> Result<Option<StoredForgotten>, Error>;
    /// Forgotten notes since `since`, newest first.
    fn forgotten_since(&self, since: i64) -> Result<Vec<StoredForgotten>, Error>;
    fn remove_forgotten(&self, note_id: &str) -> Result<(), Error>;
    /// Deletes forgotten notes from before `before`; answers their ids.
    fn prune_forgotten(&self, before: i64) -> Result<Vec<String>, Error>;

    fn setting(&self, key: &str) -> Result<Option<String>, Error>;
    fn set_setting(&self, key: &str, value: &str) -> Result<(), Error>;

    fn daily(&self, day: &str) -> Result<DailyCalls, Error>;
    /// Raises one count of `day` by one; answers the day's counts after.
    fn count_call(&self, day: &str, call: DailyCall) -> Result<DailyCalls, Error>;
}
