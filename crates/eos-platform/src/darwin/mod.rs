//! macOS, through the system's own command-line tools: nothing here links a
//! system framework. The one exception is [`qos`], two pthread calls of libSystem.

mod bundle_check;
mod desktop;
mod keychain;
pub(crate) mod qos;

use std::fs::Permissions;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub use desktop::open_in_argv;
pub use keychain::SecurityKeychain;

use crate::error::Error;
use crate::generic::owner_only;
use crate::host::{
    AppUpdatePlatform, Argv, CredentialStore, Desktop, HostFeatures, HostPlatform, KeepAwake, SpawnCommand,
    TerminalShell,
};
use crate::process;
use crate::shell::PosixShell;
use crate::tool;

// <sys/syslimits.h> OPEN_MAX
const OPEN_MAX: u64 = 10_240;

#[derive(Debug)]
pub(crate) struct Darwin {
    shell: PosixShell,
    keychain: SecurityKeychain,
    desktop: desktop::MacDesktop,
    updates: bundle_check::MacAppUpdates,
}

pub(crate) static DARWIN: Darwin = Darwin {
    shell: PosixShell::from_env(),
    keychain: SecurityKeychain::login(),
    desktop: desktop::MacDesktop,
    updates: bundle_check::MacAppUpdates,
};

/// `caffeinate -s` asserts PreventSystemSleep, which macOS honours on AC power
/// only: on battery the Mac sleeps as usual. The display still sleeps and the
/// screen still locks. `-w <pid>` ties the assertion to that process: if it
/// dies without cleaning up, caffeinate exits on its own. Closing the lid
/// still sleeps the Mac outside clamshell mode; nothing in user space changes that.
pub fn caffeinate_args(pid: u32) -> [String; 3] {
    ["-s".to_owned(), "-w".to_owned(), pid.to_string()]
}

/// The Finder moves the path to the Trash (so "Put Back" works). The path is
/// an argument of the script, never part of its text: a quote in a file name
/// cannot break out of the AppleScript.
pub fn trash_argv(path: &Path) -> Vec<String> {
    vec![
        "-e".to_owned(),
        "on run argv".to_owned(),
        "-e".to_owned(),
        "tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)".to_owned(),
        "-e".to_owned(),
        "end run".to_owned(),
        path.to_string_lossy().into_owned(),
    ]
}

impl HostPlatform for Darwin {
    fn os(&self) -> &'static str {
        "darwin"
    }

    fn features(&self) -> HostFeatures {
        HostFeatures { remote: true, posix_shell: true }
    }

    // The name people see in Finder and Sharing ("Office iMac"), not the DNS hostname.
    fn friendly_computer_name(&self) -> Option<String> {
        let out = tool::run_ok(
            "scutil",
            Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]),
            None,
            Duration::from_secs(2),
        )
        .ok()?;
        Some(out.stdout.trim().to_owned()).filter(|name| !name.is_empty())
    }

    // macOS caps open fds at kern.maxfilesperproc whatever the rlimit says, and
    // posix_spawn rejects any fd at or past OPEN_MAX: beyond that many open fds
    // no child can be started.
    fn fd_ceiling(&self) -> Option<u64> {
        let cap = tool::run_ok(
            "sysctl",
            Command::new("/usr/sbin/sysctl").args(["-n", "kern.maxfilesperproc"]),
            None,
            Duration::from_secs(2),
        )
        .ok()
        .and_then(|out| out.stdout.trim().parse::<u64>().ok())
        .filter(|cap| *cap > 0);
        Some(cap.map_or(OPEN_MAX, |cap| cap.min(OPEN_MAX)))
    }

    // A recursive watch rides the shared FSEvents stream.
    fn native_recursive_watch(&self) -> bool {
        true
    }

    fn credentials(&self) -> &dyn CredentialStore {
        &self.keychain
    }

    fn trash(&self, path: &Path) -> Result<(), Error> {
        tool::run_ok(
            "osascript",
            Command::new("/usr/bin/osascript").args(trash_argv(path)),
            None,
            Duration::from_secs(15),
        )
        .map(drop)
    }

    fn keep_awake(&self, pid: u32) -> Result<KeepAwake, Error> {
        let child = Command::new("/usr/bin/caffeinate")
            .args(caffeinate_args(pid))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Tool { tool: "caffeinate", detail: e.to_string() })?;
        Ok(KeepAwake::new(child))
    }

    fn shell(&self) -> &dyn TerminalShell {
        &self.shell
    }

    fn script_shell(&self) -> Option<PathBuf> {
        Some(PathBuf::from("/bin/sh"))
    }

    fn executable_names(&self, name: &str) -> Vec<String> {
        vec![name.to_owned()]
    }

    fn spawn_command(&self, file: &str, args: &[String]) -> SpawnCommand {
        SpawnCommand { file: file.to_owned(), args: args.to_vec(), verbatim_arguments: false }
    }

    fn isolate_command(&self, command: &mut Command) {
        process::isolate_command(command);
    }

    fn kill_process_tree(&self, pid: u32) -> Result<(), Error> {
        process::kill_process_tree(pid)
    }

    fn process_alive(&self, pid: u32) -> bool {
        process::process_alive(pid)
    }

    fn chromium_browsers(&self) -> Vec<PathBuf> {
        vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
    }

    // Releases are built for Apple Silicon only.
    // macOS shows the location prompt only for a bundle's executable, so the
    // helper is an app of its own inside the app's resources.
    fn location_helper(&self, resources: &Path, wait_seconds: u32) -> Option<Argv> {
        let file = resources.join("EosLocation.app").join("Contents").join("MacOS").join("eos-location");
        Some(Argv { file: file.to_string_lossy().into_owned(), args: vec![wait_seconds.to_string()] })
    }

    fn app_updates(&self) -> Option<&dyn AppUpdatePlatform> {
        if cfg!(target_arch = "aarch64") { Some(&self.updates) } else { None }
    }

    fn desktop(&self) -> &dyn Desktop {
        &self.desktop
    }

    fn private_file_permissions(&self) -> Option<Permissions> {
        owner_only()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn keep_awake_is_an_ac_only_assertion_tied_to_a_pid() {
        assert_eq!(caffeinate_args(123), ["-s", "-w", "123"]);
    }

    #[test]
    fn the_trash_script_takes_the_path_as_an_argument() {
        let argv = trash_argv(Path::new("/tmp/it's \"quoted\".txt"));
        assert_eq!(argv.last().map(String::as_str), Some("/tmp/it's \"quoted\".txt"));
        assert!(argv[..argv.len() - 1].iter().all(|a| !a.contains("quoted")));
        assert_eq!(argv[1], "on run argv");
    }

    #[test]
    fn dropping_the_guard_ends_caffeinate_and_leaves_no_zombie() {
        let guard = DARWIN.keep_awake(std::process::id()).expect("caffeinate");
        let pid = guard.pid();
        assert!(process::process_alive(pid));
        drop(guard);
        assert!(!process::process_alive(pid), "killed and reaped");
    }

    #[test]
    fn caffeinate_leaves_on_its_own_when_the_watched_process_dies() {
        let mut watched = Command::new("/bin/sleep").arg("30").spawn().expect("sleep");
        let guard = DARWIN.keep_awake(watched.id()).expect("caffeinate");
        watched.kill().expect("kill");
        watched.wait().expect("reap");
        // The guard's child is a zombie once it exits; ask ps for its state.
        let deadline = Instant::now() + Duration::from_secs(10);
        let exited = loop {
            let out =
                Command::new("/bin/ps").args(["-o", "stat=", "-p", &guard.pid().to_string()]).output().expect("ps");
            let state = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if state.is_empty() || state.starts_with('Z') {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(exited, "caffeinate -w exits with the process it watches");
    }

    #[test]
    fn the_host_answers_the_cheap_questions() {
        let host: &dyn HostPlatform = &DARWIN;
        assert_eq!(host.os(), "darwin");
        assert!(host.features().remote && host.features().posix_shell);
        assert!(host.fd_ceiling().is_some_and(|cap| cap > 0 && cap <= OPEN_MAX));
        assert_eq!(host.script_shell().as_deref(), Some(Path::new("/bin/sh")));
        assert_eq!(host.chromium_browsers().len(), 2);
        assert!(host.private_file_permissions().is_some());
        assert!(host.native_recursive_watch());
    }
}
