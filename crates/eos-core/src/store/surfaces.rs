//! The surface tables: `surface_defs`, `surface_versions`, `surface_issues`,
//! `surface_state` and `surface_action_log`. Titles, bodies, state and
//! action arguments and results are the user's data: never logged.

use eos_contracts::ActionClass;
use eos_surface::{IssueKind, IssueStatus, Level, MadeBy, Place, Role, VersionStatus};

use crate::Error;

/// A row of `surface_defs`: one interface of one routine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSurface {
    pub id: String,
    pub routine_id: String,
    pub level: Level,
    pub place: Place,
    pub role: Role,
    pub title: String,
    pub current_version: Option<i64>,
    pub candidate_version: Option<i64>,
    /// JSON: the problem paths of the fallbacks that call for a redesign.
    pub needs_redesign_json: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A row of `surface_versions`: one design of a surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSurfaceVersion {
    pub surface_id: String,
    pub version: i64,
    pub status: VersionStatus,
    pub base_version: Option<i64>,
    pub made_by: MadeBy,
    pub run_id: Option<String>,
    pub note: String,
    pub body_json: String,
    pub body_bytes: i64,
    pub checks_json: String,
    pub created_at: i64,
    pub kept_at: Option<i64>,
}

/// A row of `surface_issues`: one answer of a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredIssue {
    pub id: String,
    pub surface_id: String,
    /// None for a trial issue.
    pub seq: Option<i64>,
    pub run_id: Option<String>,
    pub version: Option<i64>,
    pub kind: IssueKind,
    pub status: IssueStatus,
    pub body_json: String,
    pub rev: i64,
    pub images_json: String,
    pub trial: bool,
    pub kept: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A row of `surface_state`: a surface's saved state for the whole surface
/// (`scope` empty) or one issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSurfaceState {
    pub surface_id: String,
    pub scope: String,
    pub data_json: String,
    pub bytes: i64,
    pub updated_at: i64,
}

/// A row of `surface_action_log`: one run of a direct action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredActionRecord {
    pub id: String,
    pub client_id: Option<String>,
    pub action_id: String,
    pub surface_id: Option<String>,
    pub issue_id: Option<String>,
    pub routine_id: Option<String>,
    /// `dashboard`, `phone`, `mail_link` or `app`.
    pub origin: String,
    pub class: ActionClass,
    pub args_json: String,
    /// `run`, `confirm`, `hold` or `refuse`.
    pub decision: String,
    /// `running`, `done`, `failed`, `confirming`, `held` or `refused`.
    pub status: String,
    pub result_json: Option<String>,
    pub error_kind: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

pub trait SurfaceRepo {
    /// Writes a surface in place of the one with its id.
    fn put(&self, surface: &StoredSurface) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredSurface>, Error>;
    /// The surfaces not archived, oldest first, of one routine and of one
    /// place when given.
    fn list(&self, routine_id: Option<&str>, place: Option<Place>) -> Result<Vec<StoredSurface>, Error>;
    /// Every surface of a routine, archived ones too, oldest first.
    fn of_routine(&self, routine_id: &str) -> Result<Vec<StoredSurface>, Error>;
}

pub trait SurfaceVersionRepo {
    /// Writes a version in place of the one with its surface and number.
    fn put(&self, version: &StoredSurfaceVersion) -> Result<(), Error>;
    fn find(&self, surface_id: &str, version: i64) -> Result<Option<StoredSurfaceVersion>, Error>;
    /// A surface's versions, newest first.
    fn of_surface(&self, surface_id: &str) -> Result<Vec<StoredSurfaceVersion>, Error>;
    /// The number the next version of a surface gets: one past the highest.
    fn next_number(&self, surface_id: &str) -> Result<i64, Error>;
}

pub trait SurfaceIssueRepo {
    /// Writes an issue in place of the one with its id.
    fn put(&self, issue: &StoredIssue) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredIssue>, Error>;
    /// A surface's issues, newest first: the `limit` made before the issue
    /// `before`, or the newest `limit`.
    fn of_surface(&self, surface_id: &str, before: Option<&str>, limit: i64) -> Result<Vec<StoredIssue>, Error>;
    /// The issues a run made, oldest first.
    fn of_run(&self, run_id: &str) -> Result<Vec<StoredIssue>, Error>;
    /// The number the next real issue of a surface gets: one past the highest.
    fn next_seq(&self, surface_id: &str) -> Result<i64, Error>;
    /// Removes the issues named; a missing one is not an error.
    fn delete(&self, ids: &[String]) -> Result<usize, Error>;
}

pub trait SurfaceStateRepo {
    /// Writes the state of one scope in place of what it held.
    fn put(&self, state: &StoredSurfaceState) -> Result<(), Error>;
    fn find(&self, surface_id: &str, scope: &str) -> Result<Option<StoredSurfaceState>, Error>;
}

/// A row of `surface_edits`: one edit in place, the revision it made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSurfaceEdit {
    pub issue_id: String,
    pub rev: i64,
    pub op: String,
    pub path: String,
    pub before_json: String,
    pub after_json: String,
    pub at: i64,
}

pub trait SurfaceEditRepo {
    fn insert(&self, edit: &StoredSurfaceEdit) -> Result<(), Error>;
    /// An issue's edits, oldest first.
    fn of_issue(&self, issue_id: &str) -> Result<Vec<StoredSurfaceEdit>, Error>;
}

/// The surfaces pinned on this Mac's Home, slots 1 to 3.
pub trait SurfacePinRepo {
    /// `(slot, surface id)`, by slot.
    fn list(&self) -> Result<Vec<(u8, String)>, Error>;
    /// Writes the whole set in place of what it held.
    fn replace(&self, pins: &[(u8, String)], at: i64) -> Result<(), Error>;
    /// Unpins a surface; whether it was pinned.
    fn remove(&self, surface_id: &str) -> Result<bool, Error>;
}

pub trait ActionLogRepo {
    /// Fails with a conflict when a record holds its client id already.
    fn insert(&self, record: &StoredActionRecord) -> Result<(), Error>;
    /// Writes a record in place of the one with its id.
    fn update(&self, record: &StoredActionRecord) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredActionRecord>, Error>;
    fn by_client(&self, client_id: &str) -> Result<Option<StoredActionRecord>, Error>;
    /// How many records of a surface were made at or after `since`.
    fn count_since(&self, surface_id: &str, since: i64) -> Result<i64, Error>;
}
