//! Four decisions the app makes at launch: where the data is, whether it reaches the
//! network, where it logs, and what it shows.

use std::path::{Path, PathBuf};

use crate::instance::Request;

/// The Apple Event the system launched the app with, as far as the launch decision cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchEvent {
    /// `oapp`: opened, by the user or, with the login marker, as a login item.
    OpenApplication { as_login_item: bool },
    /// `odoc`: files dropped on the closed app.
    OpenDocuments,
    /// `GURL`: a link.
    OpenUrl,
}

/// How this process was started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    Plain,
    Login,
    Background,
    Files,
    Link,
}

/// What a launch shows at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchPlan {
    pub show_window: bool,
    /// The dashboard loads with the window: a hidden start loads it on the first showing.
    pub load_dashboard: bool,
    /// The quick panel, holding what the launch brought.
    pub panel: bool,
}

impl LaunchKind {
    /// The launch's own arguments win; then the launch event. With no event, an enabled login
    /// item means the system started the app at login: two reports disagree on whether the
    /// login marker always arrives.
    pub fn of(request: &Request, event: Option<LaunchEvent>, login_item_enabled: bool) -> Self {
        match (request, event) {
            (Request::Background, _) => LaunchKind::Background,
            (Request::Open(_), _) | (_, Some(LaunchEvent::OpenUrl)) => LaunchKind::Link,
            (_, Some(LaunchEvent::OpenDocuments)) => LaunchKind::Files,
            (_, Some(LaunchEvent::OpenApplication { as_login_item: true })) => LaunchKind::Login,
            (_, None) if login_item_enabled => LaunchKind::Login,
            _ => LaunchKind::Plain,
        }
    }

    pub fn plan(self) -> LaunchPlan {
        let (show_window, panel) = match self {
            LaunchKind::Plain | LaunchKind::Link => (true, false),
            LaunchKind::Login | LaunchKind::Background => (false, false),
            LaunchKind::Files => (false, true),
        };
        LaunchPlan { show_window, load_dashboard: show_window, panel }
    }
}

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
    fn the_launch_kind_comes_from_the_arguments_then_the_event_then_the_login_item() {
        let (activate, link) = (Request::Activate, Request::Open("eos://pair/x".into()));
        let open = |as_login_item| Some(LaunchEvent::OpenApplication { as_login_item });
        assert_eq!(LaunchKind::of(&activate, open(false), true), LaunchKind::Plain, "the event wins over the item");
        assert_eq!(LaunchKind::of(&activate, open(true), false), LaunchKind::Login);
        assert_eq!(LaunchKind::of(&activate, None, true), LaunchKind::Login, "no event, the login item on");
        assert_eq!(LaunchKind::of(&activate, None, false), LaunchKind::Plain);
        assert_eq!(LaunchKind::of(&Request::Background, open(false), false), LaunchKind::Background);
        assert_eq!(LaunchKind::of(&Request::Background, None, true), LaunchKind::Background);
        assert_eq!(LaunchKind::of(&activate, Some(LaunchEvent::OpenDocuments), false), LaunchKind::Files);
        assert_eq!(LaunchKind::of(&activate, Some(LaunchEvent::OpenUrl), true), LaunchKind::Link);
        assert_eq!(LaunchKind::of(&link, open(true), false), LaunchKind::Link);
    }

    #[test]
    fn only_a_plain_launch_or_a_link_shows_the_window_and_loads_the_dashboard() {
        let plan = |show_window, load_dashboard, panel| LaunchPlan { show_window, load_dashboard, panel };
        assert_eq!(LaunchKind::Plain.plan(), plan(true, true, false));
        assert_eq!(LaunchKind::Link.plan(), plan(true, true, false));
        assert_eq!(LaunchKind::Login.plan(), plan(false, false, false));
        assert_eq!(LaunchKind::Background.plan(), plan(false, false, false));
        assert_eq!(LaunchKind::Files.plan(), plan(false, false, true));
    }

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
