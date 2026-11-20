//! The `pending_permissions` table.

use eos_domain::pending::PendingPermission;

use crate::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPending {
    pub id: String,
    pub worker_id: String,
    pub tool_name: String,
    /// The tool's input as JSON text.
    pub input: String,
    pub tool_use_id: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

/// A tool call the user denied (not one the app closed by itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserDenial {
    /// The ask's row in its table.
    pub row: i64,
    pub tool: String,
}

pub trait PendingRepo {
    fn insert(&self, new: &NewPending) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<PendingPermission>, Error>;
    /// Open asks, oldest first.
    fn list_unresolved(&self) -> Result<Vec<PendingPermission>, Error>;
    /// Records the decision (`allow` / `deny`) of an open ask; `false` when it
    /// was already resolved or does not exist. `updated_input` is JSON text.
    fn resolve(
        &self,
        id: &str,
        decision: &str,
        reason: Option<&str>,
        updated_input: Option<&str>,
    ) -> Result<bool, Error>;
    /// Denies every open ask that expired before `now`; returns how many.
    fn sweep_expired(&self, now: i64, reason: &str) -> Result<usize, Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
    /// The worker's asks the user denied after row `after`, oldest first, at
    /// most `limit`.
    fn user_denials(&self, worker_id: &str, after: i64, limit: i64) -> Result<Vec<UserDenial>, Error>;
}
