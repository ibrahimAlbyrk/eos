//! Where Eos keeps its data, and which of it cannot be regenerated.

use std::path::{Path, PathBuf};

/// The user's home folder (`$HOME`, else what the system says).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).or_else(std::env::home_dir)
}

/// The data folder: `$EOS_HOME`, else `~/.eos`.
pub fn eos_home() -> PathBuf {
    match std::env::var_os("EOS_HOME").filter(|h| !h.is_empty()) {
        Some(home) => PathBuf::from(home),
        None => home_dir().unwrap_or_default().join(".eos"),
    }
}

/// Trims, and expands a leading `~` or `~/` to the home folder (`~user` is left alone).
pub fn expand_path(path: &str) -> String {
    let path = path.trim();
    match (path.strip_prefix('~'), home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            format!("{}{rest}", home.to_string_lossy())
        }
        _ => path.to_owned(),
    }
}

/// The non-regenerable user data under the data folder
/// (`manager/shared/user-data.ts`). Every safety net — the startup snapshot,
/// home migrations — goes through this list: a new user-data file or folder
/// that is not listed here falls outside all of them. Entries missing on disk
/// are skipped, so optional ones are listed too.
pub const USER_DATA_ENTRIES: &[&str] = &[
    "state.db",
    "state.db-wal",
    "state.db-shm",
    "templates",
    "prompts",
    // User-written worker definitions.
    "workers",
    // Notes the user and agents write together; kept out of state.db so a wipe never takes them.
    "pages",
    // Profile, avatar and memories: what every agent is told about the user.
    "profile",
    // Transcripts of in-process conversations, replayed on resume.
    "conversations",
    // Browser profiles (cookies, logins).
    "browser",
    // Eos's own CLI sign-ins.
    "accounts",
    // This device's identity, the devices allowed to control it, the hosts it controls.
    "peer",
    // The sync key, its index and kept conflicts.
    "sync",
    // Provider API keys on Windows (macOS keeps them in the Keychain).
    "secrets",
    "plugins",
    "plugin-data",
    "projects.json",
    "policy.yaml",
    "config.json",
    // The trash fallback, used when the system trash is unavailable.
    ".eos-trash",
];

/// Paths inside one data folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPaths {
    home: PathBuf,
}

impl DataPaths {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    /// For the data folder of this process ([`eos_home`]).
    pub fn from_env() -> Self {
        Self::new(eos_home())
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn join(&self, name: impl AsRef<Path>) -> PathBuf {
        self.home.join(name)
    }

    pub fn state_db(&self) -> PathBuf {
        self.home.join("state.db")
    }

    /// Startup snapshots, one folder per snapshot.
    pub fn backups_dir(&self) -> PathBuf {
        self.home.join("backups")
    }

    /// Where a deleted file goes when the system trash is unavailable.
    pub fn trash_dir(&self) -> PathBuf {
        self.home.join(".eos-trash")
    }
}

/// The network name of this computer, without a trailing `.local`.
fn host_name() -> Option<String> {
    #[cfg(unix)]
    let name = rustix::system::uname().nodename().to_string_lossy().into_owned();
    #[cfg(not(unix))]
    let name = std::env::var("COMPUTERNAME").unwrap_or_default();
    let name = name.strip_suffix(".local").unwrap_or(&name);
    (!name.is_empty()).then(|| name.to_owned())
}

/// The name this computer goes by on the user's other devices: the one
/// people gave it, else its network name, else "Eos"
/// (`infra/src/peer/machine.ts`). Asking the system runs a program, so read
/// it once and keep it.
pub fn computer_name() -> String {
    crate::host().friendly_computer_name().or_else(host_name).unwrap_or_else(|| "Eos".to_owned())
}

/// Makes `dir` (and the folders above it) and closes it to everyone but the
/// user, where folders have permission bits.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_computer_has_a_name() {
        assert!(!computer_name().is_empty());
        assert!(host_name().is_none_or(|name| !name.ends_with(".local")));
    }

    #[test]
    fn data_paths_hang_off_the_home() {
        let paths = DataPaths::new("/Users/me/.eos");
        assert_eq!(paths.state_db(), Path::new("/Users/me/.eos/state.db"));
        assert_eq!(paths.backups_dir(), Path::new("/Users/me/.eos/backups"));
        assert_eq!(paths.trash_dir(), Path::new("/Users/me/.eos/.eos-trash"));
        assert_eq!(paths.join("pages/a.md"), Path::new("/Users/me/.eos/pages/a.md"));
    }

    #[test]
    fn a_tilde_expands_only_as_the_users_own_home() {
        let home = home_dir().expect("a home folder").to_string_lossy().into_owned();
        assert_eq!(expand_path("~"), home);
        assert_eq!(expand_path("  ~/code "), format!("{home}/code"));
        assert_eq!(expand_path("~other/x"), "~other/x");
        assert_eq!(expand_path("/abs/~"), "/abs/~");
        assert_eq!(expand_path(""), "");
    }

    #[test]
    fn the_manifest_names_each_entry_once() {
        let mut sorted = USER_DATA_ENTRIES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), USER_DATA_ENTRIES.len());
        assert!(USER_DATA_ENTRIES.iter().all(|e| !e.contains('/')));
    }
}
