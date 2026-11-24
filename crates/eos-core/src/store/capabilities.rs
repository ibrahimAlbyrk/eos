//! The capability tables: `capability_installs`, `capability_versions` and
//! `capability_calls`. Settings and account labels are the user's data:
//! never logged.

use eos_contracts::ActionClass;
use eos_domain::capability::health::Health;

use crate::Error;

/// Calls are kept this long.
pub const CAPABILITY_CALLS_KEPT_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// The most calls kept.
pub const CAPABILITY_CALLS_MAX: i64 = 100_000;

/// A row of `capability_installs`: one capability on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredInstall {
    pub id: String,
    /// `builtin`, `forge`, `registry` or `synced`.
    pub origin: String,
    /// None for a built-in.
    pub active_version: Option<String>,
    pub health: Health,
    /// Since when it is in its state.
    pub state_since: i64,
    /// Its settings, never secrets, as JSON.
    pub settings_json: String,
    /// The account it is signed in to.
    pub account_label: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
}

/// A row of `capability_versions`: one version of a capability's package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCapabilityVersion {
    pub capability_id: String,
    pub version: String,
    /// `proposed`, `installed`, `retired` or `rejected`.
    pub status: String,
    /// The package's hash, pinned when it was installed.
    pub hash: String,
    pub manifest_json: String,
    /// A Forge run's id, or a pinned package (`npm:pkg@1.2.3#sha512-…`).
    pub source: String,
    pub tests_json: Option<String>,
    pub review_json: Option<String>,
    pub created_at: i64,
    pub activated_at: Option<i64>,
    pub retired_at: Option<i64>,
}

/// A row of `capability_calls`: one call of an action, without its input
/// or output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCall {
    pub id: String,
    pub capability_id: String,
    pub action: String,
    pub class: ActionClass,
    /// `agent`, `delivery`, `source`, `candidates`, `health` or `surface`.
    pub caller_kind: String,
    pub worker_id: Option<String>,
    pub run_id: Option<String>,
    /// The version that answered; none for a built-in.
    pub version: Option<String>,
    pub started_at: i64,
    pub duration_ms: i64,
    /// `ok`, `error`, `denied`, `timeout` or `busy`.
    pub outcome: String,
    pub error_kind: Option<String>,
}

pub trait CapabilityInstallRepo {
    /// Writes a capability in place of the one with its id.
    fn put(&self, install: &StoredInstall) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredInstall>, Error>;
    /// Every capability, by id.
    fn list(&self) -> Result<Vec<StoredInstall>, Error>;
    /// Removes the capability's row; its versions stay. A missing row is not an error.
    fn delete(&self, id: &str) -> Result<(), Error>;
}

pub trait CapabilityVersionRepo {
    /// Fails when the capability has the version already.
    fn insert(&self, version: &StoredCapabilityVersion) -> Result<(), Error>;
    fn find(&self, capability_id: &str, version: &str) -> Result<Option<StoredCapabilityVersion>, Error>;
    /// A capability's versions, newest first.
    fn of_capability(&self, capability_id: &str) -> Result<Vec<StoredCapabilityVersion>, Error>;
    /// Sets a version's status, with when it became active or was retired;
    /// `false` when there is no such version.
    fn set_status(
        &self,
        capability_id: &str,
        version: &str,
        status: &str,
        activated_at: Option<i64>,
        retired_at: Option<i64>,
    ) -> Result<bool, Error>;
}

pub trait CapabilityCallRepo {
    fn insert(&self, call: &StoredCall) -> Result<(), Error>;
    /// A capability's last `limit` calls, newest first.
    fn recent(&self, capability_id: &str, limit: i64) -> Result<Vec<StoredCall>, Error>;
    /// Drops the calls started before `before`, then all but the newest
    /// `keep`; answers how many went. Once a day with
    /// [`CAPABILITY_CALLS_KEPT_MS`] and [`CAPABILITY_CALLS_MAX`].
    fn prune(&self, before: i64, keep: i64) -> Result<usize, Error>;
}
