//! Two decisions the app makes at launch about the user's data and the network.

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
}
