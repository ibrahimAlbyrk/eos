//! Three decisions the app makes at launch: where the data is, whether it reaches the
//! network, and where it logs.

use std::path::{Path, PathBuf};

/// Where the core keeps its data: the folder named (`EOS_HOME`) when there is one, else the
/// user's own `~/.eos` in a release build. A development build has no default, so nothing
/// opens the real data by accident.
pub fn data_folder(named: Option<PathBuf>, user_home: &Path, release: bool) -> Option<PathBuf> {
    named.or_else(|| release.then(|| user_home.join(".eos")))
}

/// Whether the app may reach other computers: dial the phone's relay, listen for paired
/// computers and dial the ones it controls. Only the installed app on the user's own data
/// folder: never a development build, and never a copy of a data folder (a test, a replay),
/// which holds someone's identity and must never answer or call as their computer.
pub fn reaches_network(home: &Path, user_home: &Path, release: bool) -> bool {
    release && home == user_home.join(".eos")
}

/// Where the app writes its logs (`core.log`, `shell.log`): beside the data of the run.
///
/// - a shell data folder that was named (`EOS_SHELL_DATA`: every test and dev run) holds
///   them in its `logs/`;
/// - the user's own app (the default shell folder, the core on `~/.eos` or no core in a
///   release build) logs in the default shell folder's `logs/`, beside `shell.log` as ever;
/// - the default shell folder with the core on another data folder logs in that folder's
///   `logs/`, never in the user's;
/// - a development build with neither named writes no file (stderr only).
///
/// Never `~/.eos/logs`: that folder is the 0.1.x app's, and `~/.eos` is synced, backed up
/// and copied for dev runs, which logs have no business in.
pub fn logs_folder(
    shell_data: &Path,
    shell_data_named: bool,
    core_home: Option<&Path>,
    user_home: &Path,
    release: bool,
) -> Option<PathBuf> {
    if shell_data_named {
        return Some(shell_data.join("logs"));
    }
    match core_home {
        Some(home) if home == user_home.join(".eos") => Some(shell_data.join("logs")),
        Some(home) => Some(home.join("logs")),
        None => release.then(|| shell_data.join("logs")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_release_build_opens_the_users_own_data_folder_unasked() {
        let user = Path::new("/Users/me");
        assert_eq!(data_folder(None, user, true), Some(PathBuf::from("/Users/me/.eos")));
        assert_eq!(data_folder(None, user, false), None, "a development build needs EOS_HOME");
        let copy = PathBuf::from("/tmp/copy");
        assert_eq!(data_folder(Some(copy.clone()), user, true), Some(copy.clone()));
        assert_eq!(data_folder(Some(copy.clone()), user, false), Some(copy));
    }

    #[test]
    fn only_the_installed_app_on_the_users_own_data_reaches_other_computers() {
        let user = Path::new("/Users/me");
        assert!(reaches_network(Path::new("/Users/me/.eos"), user, true));
        assert!(reaches_network(Path::new("/Users/me/.eos/"), user, true));
        assert!(!reaches_network(Path::new("/Users/me/.eos"), user, false), "never a development build");
        assert!(!reaches_network(Path::new("/tmp/eos-copy"), user, true), "never a copy of a data folder");
        assert!(!reaches_network(Path::new("/Users/other/.eos"), user, true));
    }

    #[test]
    fn a_run_logs_beside_its_own_data_and_never_into_the_users() {
        let user = Path::new("/Users/me");
        let default_shell = Path::new("/Users/me/Library/Application Support/com.ibrahimalbyrk.eos");
        let users_logs = Some(default_shell.join("logs"));
        // The installed app.
        assert_eq!(logs_folder(default_shell, false, Some(&user.join(".eos")), user, true), users_logs);
        assert_eq!(logs_folder(default_shell, false, None, user, true), users_logs);
        // A test or dev run names its shell folder: its logs are there.
        let run = Path::new("/tmp/run/data");
        assert_eq!(logs_folder(run, true, Some(Path::new("/tmp/run/home")), user, false), Some(run.join("logs")));
        assert_eq!(logs_folder(run, true, None, user, false), Some(run.join("logs")));
        // Another data folder with the default shell folder: beside that data.
        let copy = Path::new("/tmp/copy");
        assert_eq!(logs_folder(default_shell, false, Some(copy), user, true), Some(copy.join("logs")));
        assert_eq!(logs_folder(default_shell, false, Some(copy), user, false), Some(copy.join("logs")));
        // A dev build with nothing named writes no file.
        assert_eq!(logs_folder(default_shell, false, None, user, false), None);
        // Never ~/.eos/logs.
        for named in [true, false] {
            for release in [true, false] {
                let folder = logs_folder(default_shell, named, Some(&user.join(".eos")), user, release);
                assert_ne!(folder, Some(user.join(".eos/logs")));
            }
        }
    }
}
