//! Making sure nothing runs from the installed app before it is swapped: the
//! app is asked to quit as its menu would, the TypeScript-era daemon is
//! stopped through launchd, and then every process of the bundle must be
//! gone. Nothing is ever killed: what does not end is reported, and the swap
//! does not happen.

use std::path::Path;
use std::time::Duration;

use eos_update::legacy::LegacyDaemon;

use super::system::{Process, System};

/// How long a running app gets to quit: the Rust app stops its core within
/// 5 s; an app that asks the person something waits for the answer.
pub(crate) const QUIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the bundle's other processes (helpers, the old daemon's children)
/// get to end after that.
pub(crate) const SETTLE_TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(250);

/// What was stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stopped {
    /// How many running apps were asked to quit.
    pub(crate) apps: usize,
    /// The TypeScript-era daemon, when it was asked about (the user's own data folder only).
    pub(crate) daemon: Option<LegacyDaemon>,
}

/// Why the swap does not happen: something still runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Busy {
    /// Asked to quit, still running (process ids).
    Apps(Vec<u32>),
    /// launchd still lists the TypeScript-era daemon.
    Daemon,
    /// Processes still running from inside the bundle.
    Processes(Vec<Process>),
}

/// Quits whatever runs from `bundle`. `legacy`: also stop the TypeScript-era
/// daemon, which works on the user's own `~/.eos` wherever it runs from.
pub(crate) fn stop_everything_in(bundle: &Path, system: &dyn System, legacy: bool) -> Result<Stopped, Busy> {
    let apps = system.apps_in(bundle);
    for pid in &apps {
        system.ask_to_quit(*pid);
    }
    if !wait(system, QUIT_TIMEOUT, || system.apps_in(bundle).is_empty()) {
        return Err(Busy::Apps(system.apps_in(bundle)));
    }
    // After the app: the old app watches its daemon and would start it again.
    let daemon = legacy.then(|| system.stop_legacy_daemon());
    if daemon == Some(LegacyDaemon::StillStopping) {
        return Err(Busy::Daemon);
    }
    if !wait(system, SETTLE_TIMEOUT, || system.processes_in(bundle).is_empty()) {
        return Err(Busy::Processes(system.processes_in(bundle)));
    }
    Ok(Stopped { apps: apps.len(), daemon })
}

fn wait(system: &dyn System, timeout: Duration, done: impl Fn() -> bool) -> bool {
    let mut waited = Duration::ZERO;
    loop {
        if done() {
            return true;
        }
        if waited >= timeout {
            return false;
        }
        system.sleep(POLL);
        waited += POLL;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::path::PathBuf;

    use super::*;

    /// A system whose apps quit after being asked `quits_after` looks (never
    /// when `None`), whose processes end `settles_after` looks after the apps
    /// have, and which records every call.
    #[derive(Debug)]
    pub(crate) struct FakeSystem {
        pub(crate) running: Cell<bool>,
        pub(crate) quits_after: Option<u32>,
        pub(crate) settles_after: Option<u32>,
        pub(crate) daemon: LegacyDaemon,
        pub(crate) calls: RefCell<Vec<String>>,
        pub(crate) asked: Cell<bool>,
        pub(crate) looks: Cell<u32>,
        pub(crate) process_looks: Cell<u32>,
    }

    impl FakeSystem {
        pub(crate) fn new(running: bool) -> Self {
            Self {
                running: Cell::new(running),
                quits_after: Some(2),
                settles_after: Some(1),
                daemon: LegacyDaemon::NotLoaded,
                calls: RefCell::default(),
                asked: Cell::new(false),
                looks: Cell::new(0),
                process_looks: Cell::new(0),
            }
        }

        fn call(&self, call: impl Into<String>) {
            let call = call.into();
            // Polls are noise in the record: only the first look of a kind is kept.
            if self.calls.borrow().last() != Some(&call) {
                self.calls.borrow_mut().push(call);
            }
        }

        pub(crate) fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl System for FakeSystem {
        fn apps_in(&self, _bundle: &Path) -> Vec<u32> {
            self.call("apps");
            if self.asked.get() {
                self.looks.set(self.looks.get() + 1);
                if self.quits_after.is_some_and(|n| self.looks.get() > n) {
                    self.running.set(false);
                }
            }
            if self.running.get() { vec![4242] } else { Vec::new() }
        }

        fn ask_to_quit(&self, pid: u32) {
            self.call(format!("quit {pid}"));
            self.asked.set(true);
        }

        fn processes_in(&self, bundle: &Path) -> Vec<Process> {
            self.call("processes");
            self.process_looks.set(self.process_looks.get() + 1);
            let settled = self.settles_after.is_some_and(|n| self.process_looks.get() > n);
            if settled || !self.asked.get() {
                return Vec::new();
            }
            vec![Process { pid: 4343, executable: format!("{}/Contents/MacOS/Eos", bundle.display()) }]
        }

        fn stop_legacy_daemon(&self) -> LegacyDaemon {
            self.call("stop daemon");
            self.daemon
        }

        fn open(&self, app: &Path, home: Option<&Path>) -> io::Result<()> {
            let home = home.map(|h| format!(" EOS_HOME={}", h.display())).unwrap_or_default();
            self.call(format!("open {}{home}", app.display()));
            Ok(())
        }

        fn sleep(&self, _time: Duration) {}
    }

    fn bundle() -> PathBuf {
        PathBuf::from("/Applications/Eos.app")
    }

    #[test]
    fn the_app_is_asked_to_quit_then_the_old_daemon_is_stopped_then_nothing_may_run() {
        let system = FakeSystem::new(true);
        let stopped = stop_everything_in(&bundle(), &system, true).expect("stopped");
        assert_eq!(stopped, Stopped { apps: 1, daemon: Some(LegacyDaemon::NotLoaded) });
        assert_eq!(system.calls(), ["apps", "quit 4242", "apps", "stop daemon", "processes"]);
    }

    #[test]
    fn launchd_is_left_alone_for_another_data_folder() {
        let system = FakeSystem::new(false);
        let stopped = stop_everything_in(&bundle(), &system, false).expect("stopped");
        assert_eq!(stopped, Stopped { apps: 0, daemon: None });
        assert!(!system.calls().contains(&"stop daemon".to_owned()));
    }

    #[test]
    fn an_app_that_does_not_quit_stops_everything_and_nothing_is_stopped_after_it() {
        let system = FakeSystem { quits_after: None, ..FakeSystem::new(true) };
        assert_eq!(stop_everything_in(&bundle(), &system, true), Err(Busy::Apps(vec![4242])));
        assert!(!system.calls().contains(&"stop daemon".to_owned()), "the daemon is left running with its app");
    }

    #[test]
    fn a_daemon_that_does_not_stop_is_reported() {
        let system = FakeSystem { daemon: LegacyDaemon::StillStopping, ..FakeSystem::new(false) };
        assert_eq!(stop_everything_in(&bundle(), &system, true), Err(Busy::Daemon));
    }

    #[test]
    fn processes_that_outlive_their_app_are_listed() {
        let system = FakeSystem { settles_after: None, ..FakeSystem::new(true) };
        match stop_everything_in(&bundle(), &system, true) {
            Err(Busy::Processes(left)) => assert_eq!(left[0].pid, 4343),
            other => panic!("{other:?}"),
        }
    }
}
