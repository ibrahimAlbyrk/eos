//! What the installer asks of macOS: the running apps and processes of a
//! bundle, the TypeScript-era daemon under launchd, opening an app. Through
//! the system's own tools; nothing here signals a process.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use eos_update::legacy::{self, LegacyDaemon};

/// A process running from inside a bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Process {
    pub(crate) pid: u32,
    pub(crate) executable: String,
}

pub(crate) trait System {
    /// The apps macOS lists as running from the bundle at `bundle` (process ids).
    fn apps_in(&self, bundle: &Path) -> Vec<u32>;
    /// Asks a running app to quit, as its Quit menu item does: it ends its work
    /// first and may ask the person something.
    fn ask_to_quit(&self, pid: u32);
    /// Every process whose executable lies inside `bundle`.
    fn processes_in(&self, bundle: &Path) -> Vec<Process>;
    /// Stops the TypeScript-era daemon under launchd and waits for it
    /// (`eos_update::legacy`, the call the Rust app's own first start makes).
    fn stop_legacy_daemon(&self) -> LegacyDaemon;
    /// Opens the app; `home` is the data folder it is to open when that is not
    /// the user's own `~/.eos`.
    fn open(&self, app: &Path, home: Option<&Path>) -> io::Result<()>;
    fn sleep(&self, time: Duration);
}

/// macOS.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MacSystem;

/// Lists running apps by bundle path and asks one to quit
/// (`NSRunningApplication.terminate`: the quit the Dock sends).
const APPS_SCRIPT: &str = r"ObjC.import('AppKit');
function run(argv) {
  if (argv[0] === 'list') {
    const want = argv.slice(1);
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    const pids = [];
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      const url = app.bundleURL;
      if (!url.isNil() && want.includes(url.path.js)) pids.push(app.processIdentifier);
    }
    return pids.join(' ');
  }
  if (argv[0] === 'quit') {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[1]));
    return !app.isNil() && app.terminate ? 'asked' : 'gone';
  }
}";

fn apps_script(args: &[&std::ffi::OsStr]) -> Option<String> {
    let out = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", APPS_SCRIPT])
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The bundle as given and as the system resolves it: a process shows the
/// path it was started by, which may be either.
fn names_of(bundle: &Path) -> Vec<PathBuf> {
    let mut names = vec![bundle.to_owned()];
    if let Ok(resolved) = std::fs::canonicalize(bundle)
        && resolved != bundle
    {
        names.push(resolved);
    }
    names
}

/// Process ids from the list script's answer.
pub(crate) fn parse_pids(text: &str) -> Vec<u32> {
    text.split_whitespace().filter_map(|pid| pid.parse().ok()).collect()
}

/// The processes whose executable lies inside one of `bundles`, from
/// `ps -axo pid=,comm=` output. The executable decides, never a command line:
/// an editor opened on a file inside the bundle is not the app.
pub(crate) fn processes_in(ps_output: &str, bundles: &[PathBuf]) -> Vec<Process> {
    let inside: Vec<String> = bundles.iter().map(|bundle| format!("{}/", bundle.display())).collect();
    ps_output
        .lines()
        .filter_map(|line| {
            let (pid, executable) = line.trim_start().split_once(' ')?;
            let executable = executable.trim_start();
            if !inside.iter().any(|prefix| executable.starts_with(prefix)) {
                return None;
            }
            Some(Process { pid: pid.parse().ok()?, executable: executable.to_owned() })
        })
        .collect()
}

impl System for MacSystem {
    fn apps_in(&self, bundle: &Path) -> Vec<u32> {
        let names = names_of(bundle);
        let mut args: Vec<&std::ffi::OsStr> = vec!["list".as_ref()];
        args.extend(names.iter().map(|name| name.as_os_str()));
        apps_script(&args).map(|text| parse_pids(&text)).unwrap_or_default()
    }

    fn ask_to_quit(&self, pid: u32) {
        let pid = pid.to_string();
        apps_script(&["quit".as_ref(), pid.as_ref()]);
    }

    fn processes_in(&self, bundle: &Path) -> Vec<Process> {
        let Ok(out) = Command::new("/bin/ps").args(["-axo", "pid=,comm="]).stdin(Stdio::null()).output() else {
            return Vec::new();
        };
        processes_in(&String::from_utf8_lossy(&out.stdout), &names_of(bundle))
    }

    fn stop_legacy_daemon(&self) -> LegacyDaemon {
        match legacy::Launchctl::for_this_user() {
            Some(launchctl) => legacy::stop_legacy_daemon(&launchctl, legacy::LEGACY_DAEMON_STOP_TIMEOUT),
            None => LegacyDaemon::NotLoaded,
        }
    }

    fn open(&self, app: &Path, home: Option<&Path>) -> io::Result<()> {
        let mut open = Command::new("/usr/bin/open");
        if let Some(home) = home {
            open.arg("--env").arg(format!("EOS_HOME={}", home.display()));
        }
        let status = open.arg(app).stdin(Stdio::null()).status()?;
        if status.success() { Ok(()) } else { Err(io::Error::other(format!("open ended with {status}"))) }
    }

    fn sleep(&self, time: Duration) {
        std::thread::sleep(time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_processes_running_from_inside_the_bundle_are_listed() {
        let ps = "  101 /Applications/Eos.app/Contents/MacOS/Eos\n  102 /Applications/Eos.app/Contents/Frameworks/Eos Helper (GPU).app/Contents/MacOS/Eos Helper (GPU)\n  103 /Applications/Eos.app.bak/Contents/MacOS/Eos\n  104 /usr/bin/vim\n  bad /Applications/Eos.app/Contents/MacOS/Eos\n";
        let found = processes_in(ps, &[PathBuf::from("/Applications/Eos.app")]);
        assert_eq!(found.iter().map(|p| p.pid).collect::<Vec<_>>(), [101, 102]);
        assert_eq!(
            found[1].executable,
            "/Applications/Eos.app/Contents/Frameworks/Eos Helper (GPU).app/Contents/MacOS/Eos Helper (GPU)"
        );
        let both = [PathBuf::from("/Applications/Other.app"), PathBuf::from("/Applications/Eos.app.bak")];
        assert_eq!(processes_in(ps, &both).iter().map(|p| p.pid).collect::<Vec<_>>(), [103]);
    }

    #[test]
    fn the_list_scripts_answer_is_read_as_process_ids() {
        assert_eq!(parse_pids("1487 2001\n"), [1487, 2001]);
        assert!(parse_pids("\n").is_empty());
    }

    #[test]
    fn a_bundle_nothing_runs_from_lists_nothing() {
        let tmp = tempfile::tempdir().expect("tmp");
        let bundle = tmp.path().join("Eos.app");
        assert!(MacSystem.processes_in(&bundle).is_empty());
    }
}
