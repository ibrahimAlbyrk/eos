//! Retiring what the TypeScript-era app left running.
//!
//! That app ran its daemon as a launchd agent (`com.ibrahimalbyrk.eos.daemon`,
//! plist at `~/.eos/daemon.plist`, loaded into the user's GUI session — never
//! at login). The Rust app has no daemon. When it starts over a TypeScript-era
//! install, a daemon launchd still keeps alive would run beside it on the same
//! data folder, restarted from a bundle that no longer holds it.
//!
//! Two steps, so that nothing here stops the previous version from coming
//! back if this one fails to start:
//!
//! - [`stop_legacy_daemon`], before the data folder is opened: asks launchd to
//!   stop and forget the agent. The TypeScript app loads it again whenever it
//!   starts, so this undoes itself on a rollback.
//! - [`remove_legacy_plist`], once this version has reported in: deletes the
//!   plist (it holds the old app's environment). The TypeScript app writes it
//!   again on every start.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The launchd label of the TypeScript-era daemon (`infra/src/daemon/launchd.ts`).
pub const LEGACY_DAEMON_LABEL: &str = "com.ibrahimalbyrk.eos.daemon";
/// Its plist, under the data folder.
pub const LEGACY_DAEMON_PLIST: &str = "daemon.plist";
/// Above the old daemon's own shutdown deadline (5 s) and its launchd `ExitTimeOut` (10 s).
pub const LEGACY_DAEMON_STOP_TIMEOUT: Duration = Duration::from_secs(12);
const POLL: Duration = Duration::from_millis(100);

/// The user's launchd session, as far as retiring an agent needs it.
pub trait Launchd {
    /// launchd knows the service. A service asked to stop stays listed until
    /// its process has exited.
    fn loaded(&self, label: &str) -> bool;
    /// Asks launchd to stop the service and forget it; returns at once.
    /// `false` when it was not loaded.
    fn bootout(&self, label: &str) -> bool;
}

/// `launchctl`, for one user's GUI session.
#[derive(Debug, Clone)]
pub struct Launchctl {
    program: PathBuf,
    domain: String,
}

impl Launchctl {
    /// The system's `launchctl` for the user this process runs as; `None`
    /// where there is no such thing.
    pub fn for_this_user() -> Option<Self> {
        let program = Path::new("/bin/launchctl");
        let user_id = eos_platform::user_id()?;
        program.is_file().then(|| Self::new(program, user_id))
    }

    /// `program` stands in for `launchctl` (tests use a script).
    pub fn new(program: impl Into<PathBuf>, user_id: u32) -> Self {
        Self { program: program.into(), domain: format!("gui/{user_id}") }
    }

    fn run(&self, verb: &str, label: &str) -> bool {
        Command::new(&self.program)
            .arg(verb)
            .arg(format!("{}/{label}", self.domain))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}

impl Launchd for Launchctl {
    fn loaded(&self, label: &str) -> bool {
        self.run("print", label)
    }

    fn bootout(&self, label: &str) -> bool {
        self.run("bootout", label)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyDaemon {
    /// launchd did not know the agent: nothing was done.
    NotLoaded,
    /// The agent was stopped and is gone.
    Stopped,
    /// Asked to stop, still listed after the deadline.
    StillStopping,
}

/// Stops the TypeScript-era daemon when launchd still runs it, and waits up
/// to `timeout` for it to be gone. Blocks; call it before the data folder is opened.
pub fn stop_legacy_daemon(launchd: &dyn Launchd, timeout: Duration) -> LegacyDaemon {
    if !launchd.bootout(LEGACY_DAEMON_LABEL) {
        return LegacyDaemon::NotLoaded;
    }
    let give_up_at = Instant::now() + timeout;
    loop {
        if !launchd.loaded(LEGACY_DAEMON_LABEL) {
            return LegacyDaemon::Stopped;
        }
        if Instant::now() >= give_up_at {
            return LegacyDaemon::StillStopping;
        }
        std::thread::sleep(POLL);
    }
}

/// Deletes the TypeScript-era daemon's plist from the data folder. Returns
/// whether there was one.
pub fn remove_legacy_plist(home: &Path) -> io::Result<bool> {
    match fs::remove_file(home.join(LEGACY_DAEMON_PLIST)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A stand-in `launchctl`: a script that logs every call and keeps its
    /// "service" in files beside it. `loaded` holds how many more `print`
    /// calls still find the service after a bootout (absent: not loaded).
    struct FakeLaunchctl {
        dir: tempfile::TempDir,
    }

    impl FakeLaunchctl {
        fn new(prints_until_gone: Option<u32>) -> Self {
            let dir = tempfile::tempdir().expect("dir");
            let script = r#"#!/bin/sh
here="$(dirname "$0")"
echo "$1 $2" >> "$here/calls"
[ -f "$here/loaded" ] || exit 113
case "$1" in
  bootout) exit 0 ;;
  print)
    left="$(cat "$here/loaded")"
    if [ "$left" -le 0 ]; then rm "$here/loaded"; exit 113; fi
    echo $((left - 1)) > "$here/loaded"
    exit 0 ;;
esac
exit 64
"#;
            fs::write(dir.path().join("launchctl"), script).expect("script");
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.path().join("launchctl"), fs::Permissions::from_mode(0o755)).expect("mode");
            if let Some(prints) = prints_until_gone {
                fs::write(dir.path().join("loaded"), prints.to_string()).expect("state");
            }
            Self { dir }
        }

        fn launchctl(&self) -> Launchctl {
            Launchctl::new(self.dir.path().join("launchctl"), 501)
        }

        fn calls(&self) -> Vec<String> {
            fs::read_to_string(self.dir.path().join("calls")).unwrap_or_default().lines().map(str::to_owned).collect()
        }
    }

    const TARGET: &str = "gui/501/com.ibrahimalbyrk.eos.daemon";

    #[test]
    fn an_agent_launchd_does_not_know_is_left_alone() {
        let fake = FakeLaunchctl::new(None);
        assert_eq!(stop_legacy_daemon(&fake.launchctl(), Duration::from_secs(5)), LegacyDaemon::NotLoaded);
        assert_eq!(fake.calls(), [format!("bootout {TARGET}")]);
    }

    #[test]
    fn a_loaded_agent_is_booted_out_and_waited_for() {
        // Still listed for two looks after the bootout: its process is exiting.
        let fake = FakeLaunchctl::new(Some(2));
        assert_eq!(stop_legacy_daemon(&fake.launchctl(), Duration::from_secs(5)), LegacyDaemon::Stopped);
        assert_eq!(
            fake.calls(),
            [
                format!("bootout {TARGET}"),
                format!("print {TARGET}"),
                format!("print {TARGET}"),
                format!("print {TARGET}")
            ]
        );
    }

    #[test]
    fn an_agent_that_does_not_go_away_is_reported_after_the_deadline() {
        let fake = FakeLaunchctl::new(Some(1_000_000));
        assert_eq!(stop_legacy_daemon(&fake.launchctl(), Duration::from_millis(250)), LegacyDaemon::StillStopping);
        assert_eq!(fake.calls()[0], format!("bootout {TARGET}"));
    }

    #[test]
    fn only_the_one_label_of_this_users_session_is_ever_named() {
        let fake = FakeLaunchctl::new(Some(0));
        stop_legacy_daemon(&fake.launchctl(), Duration::from_secs(5));
        assert!(fake.calls().iter().all(|call| call.ends_with(TARGET)), "{:?}", fake.calls());
    }

    #[test]
    fn the_plist_goes_once_and_a_missing_one_is_fine() {
        let home = tempfile::tempdir().expect("dir");
        assert!(!remove_legacy_plist(home.path()).expect("nothing there"));
        fs::write(home.path().join("daemon.plist"), "<plist/>").expect("plist");
        fs::write(home.path().join("config.json"), "{}").expect("config");
        assert!(remove_legacy_plist(home.path()).expect("removed"));
        assert!(!home.path().join("daemon.plist").exists());
        assert!(home.path().join("config.json").exists(), "nothing else in the data folder is touched");
    }
}
