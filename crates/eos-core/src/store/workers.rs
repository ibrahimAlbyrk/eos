//! The `workers` table.

use eos_contracts::{NameSource, WorkerState};
use eos_domain::{Usage, Worker};

use crate::Error;

/// A worker about to be inserted. It starts in `Spawning`.
#[derive(Debug, Clone, PartialEq)]
pub struct NewWorker {
    pub id: String,
    pub prompt: String,
    pub cwd: Option<String>,
    pub worktree_from: Option<String>,
    pub branch: Option<String>,
    pub name: Option<String>,
    pub name_source: NameSource,
    pub pid: Option<i64>,
    pub port: i64,
    /// Also the first turn's start.
    pub started_at: i64,
    pub parent_id: Option<String>,
    pub model: String,
    pub effort: Option<String>,
    pub is_orchestrator: bool,
    pub backend_kind: String,
    pub backend_profile: Option<String>,
    pub agent_role: Option<String>,
    pub worker_definition: Option<String>,
    /// The tool scope as JSON text.
    pub tool_scope: Option<String>,
    pub with_gateway: bool,
    pub collaborate: bool,
    pub worktree_dir: Option<String>,
    pub workspace_owner_id: Option<String>,
    /// False only for a worktree that does not exist on disk yet.
    pub workspace_ready: bool,
    pub scratch: bool,
}

pub trait WorkerRepo {
    fn insert(&self, worker: &NewWorker) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<Worker>, Error>;
    /// Every row, archived ones included, newest first.
    fn list_all(&self) -> Result<Vec<Worker>, Error>;
    /// Archived ones included, newest first.
    fn list_by_parent(&self, parent_id: &str) -> Result<Vec<Worker>, Error>;
    /// Oldest first.
    fn list_orchestrators(&self) -> Result<Vec<Worker>, Error>;
    /// Not archived, newest first.
    fn list_active(&self) -> Result<Vec<Worker>, Error>;
    /// Archived, newest first.
    fn list_archived(&self) -> Result<Vec<Worker>, Error>;
    fn find_children_ids(&self, parent_id: &str) -> Result<Vec<String>, Error>;
    /// `(state, rows)` for every state that has rows.
    fn count_by_state(&self) -> Result<Vec<(String, i64)>, Error>;

    /// Writes the state only: whether the move is allowed is the caller's
    /// question (`eos_domain::can_transition`).
    fn update_state(&self, id: &str, state: WorkerState) -> Result<(), Error>;
    fn set_turn_started_at(&self, id: &str, ts: i64) -> Result<(), Error>;
    fn mark_done(&self, id: &str, ended_at: i64, exit_code: Option<i64>) -> Result<(), Error>;
    /// Adds to the running totals. Never touches the context size.
    fn add_usage(&self, id: &str, delta: &Usage) -> Result<(), Error>;
    /// Replaces the context size with the latest request's.
    fn set_context_tokens(&self, id: &str, tokens: i64) -> Result<(), Error>;
    fn increment_tool_calls(&self, id: &str) -> Result<(), Error>;
    fn update_name(&self, id: &str, name: Option<&str>, source: NameSource) -> Result<(), Error>;
    /// Renames only while the name still comes from `expected`; says whether
    /// it did. An automatic name never replaces one the user chose.
    fn update_name_if_source(
        &self,
        id: &str,
        name: &str,
        expected: NameSource,
        next: NameSource,
    ) -> Result<bool, Error>;
    fn update_permission_mode(&self, id: &str, mode: &str) -> Result<(), Error>;
    fn update_model(&self, id: &str, model: &str, effort: Option<&str>) -> Result<(), Error>;
    fn update_backend_kind(&self, id: &str, kind: &str) -> Result<(), Error>;
    fn set_worktree_dir(&self, id: &str, dir: &str) -> Result<(), Error>;
    fn set_fork_base_sha(&self, id: &str, sha: &str) -> Result<(), Error>;
    fn set_workspace_ready(&self, id: &str) -> Result<(), Error>;
    /// Records the session this app continues the worker's conversation in.
    /// The Claude Code session the TypeScript app resumes a chat by stays as
    /// it is: a user who goes back to that app must still be able to go on.
    fn set_engine_session(&self, id: &str, session_id: &str) -> Result<(), Error>;
    /// The task list as JSON text; `None` clears it.
    fn set_tasks(&self, id: &str, tasks: Option<&str>) -> Result<(), Error>;
    /// Forgets the process (pid and port): it is known to be gone.
    fn clear_runtime(&self, id: &str) -> Result<(), Error>;
    /// Stamps or clears the archived mark. Never touches the state.
    fn set_archived(&self, id: &str, at: Option<i64>) -> Result<(), Error>;
    /// Binds a revived row to its new process and clears how the old one ended.
    fn reactivate(&self, id: &str, pid: Option<i64>, port: i64) -> Result<(), Error>;
    fn delete(&self, id: &str) -> Result<(), Error>;
}
