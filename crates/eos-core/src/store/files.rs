//! Files of the data folder that are not the database: `config.json`,
//! `settings.json`, `projects.json`, `recents.json`; and Claude Code's memory
//! of a project.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_contracts::{MemoryEntry, Project, ProjectUpsertRequest, UserSettings};
use eos_domain::config::Config;

use crate::Error;

/// The configuration in force. Each call returns the current snapshot: hold it
/// for one piece of work, not for the life of a service, so a reload is seen.
pub trait ConfigSource: Send + Sync + 'static {
    fn current(&self) -> Arc<Config>;
    /// The backend profiles `config.json` itself declares, as opposed to the
    /// built-in ones merged in; `None` when the file declares none.
    fn declared_backends(&self) -> Option<Vec<String>>;
    /// Reads `config.json` again and swaps the snapshot.
    fn reload(&self) -> Arc<Config>;
    /// Merges `patch` into the file's `section` and reloads: a `null` value
    /// removes its key, so a cleared field leaves nothing behind. The file is
    /// the only way the configuration changes.
    fn patch(&self, section: &str, patch: serde_json::Map<String, serde_json::Value>) -> Result<Arc<Config>, Error>;
}

/// The user's flat settings (`settings.json`): what the dashboard remembers.
pub trait UserSettingsStore: Send + Sync + 'static {
    fn read(&self) -> UserSettings;
    /// Writes `partial` over the stored settings and returns the result.
    fn patch(&self, partial: UserSettings) -> Result<UserSettings, Error>;
}

/// The user's projects (`projects.json`), in creation order.
pub trait ProjectStore: Send + Sync + 'static {
    fn list(&self) -> Vec<Project>;
    /// Creates (no id) or replaces (a known id) a project; folders are deduplicated.
    fn upsert(&self, input: ProjectUpsertRequest) -> Result<Project, Error>;
    /// Removes a project and returns it; `None` when there is none.
    fn remove(&self, id: &str) -> Result<Option<Project>, Error>;
}

/// Recently used folders (`recents.json`), most recent first.
pub trait RecentFolders: Send + Sync + 'static {
    /// The folders that still exist. A deleted one is hidden, not forgotten.
    fn list(&self) -> Vec<String>;
    fn push(&self, path: &str);
    fn remove(&self, path: &str);
}

/// Claude Code's file memory of a project: one markdown file per memory under
/// `<Claude home>/projects/<project key>/memory`, and the `MEMORY.md` index.
pub trait ProjectMemoryStore: Send + Sync + 'static {
    /// The memory folder of a project folder, keyed by its real path as
    /// Claude Code keys it.
    fn dir_of(&self, project: &Path) -> PathBuf;
    /// Every memory in `dir`, the most recently changed first; empty when the
    /// folder is not there. `MEMORY.md` and the `.trash` folder are left out.
    fn list(&self, dir: &Path) -> Vec<MemoryEntry>;
    /// Moves `<name>.md` into `dir/.trash` (recoverable) and drops its line
    /// from `MEMORY.md`. `false` when there is no such memory.
    fn remove(&self, dir: &Path, name: &str) -> Result<bool, Error>;
}
