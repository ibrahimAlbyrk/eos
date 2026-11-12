//! macOS, through its own tools: no library beyond std is linked.

use std::io;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::System;

/// The real system.
#[derive(Debug, Default, Clone, Copy)]
pub struct MacSystem;

fn quiet(program: &str) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

/// The processes whose executable lies inside one of `bundles` (the same
/// bundle under each of its names), from `ps -axo pid=,comm=` output. The
/// executable's path decides, never a command line: an editor opened on a
/// file inside the bundle is not the app.
pub(crate) fn pids_in(ps_output: &str, bundles: &[&Path], own: u32) -> Vec<u32> {
    let inside: Vec<String> = bundles.iter().map(|bundle| format!("{}/", bundle.display())).collect();
    ps_output
        .lines()
        .filter_map(|line| {
            let (pid, executable) = line.trim_start().split_once(' ')?;
            let pid: u32 = pid.parse().ok()?;
            let executable = executable.trim_start();
            (pid != own && inside.iter().any(|prefix| executable.starts_with(prefix))).then_some(pid)
        })
        .collect()
}

impl System for MacSystem {
    fn process_alive(&self, pid: u32) -> bool {
        quiet("/bin/kill").args(["-0", &pid.to_string()]).status().is_ok_and(|s| s.success())
    }

    fn open(&self, app: &Path) -> io::Result<()> {
        let status = quiet("/usr/bin/open").arg(app).status()?;
        if status.success() { Ok(()) } else { Err(io::Error::other(format!("open ended with {status}"))) }
    }

    fn stop_processes_in(&self, bundle: &Path) -> usize {
        let Ok(out) = Command::new("/bin/ps").args(["-axo", "pid=,comm="]).stdin(Stdio::null()).output() else {
            return 0;
        };
        // A process shows the path it was started by, which may be the bundle's
        // resolved path or the one with a link in it.
        let resolved = std::fs::canonicalize(bundle).unwrap_or_else(|_| bundle.to_owned());
        let pids = pids_in(&String::from_utf8_lossy(&out.stdout), &[bundle, &resolved], std::process::id());
        for pid in &pids {
            let _ = quiet("/bin/kill").args(["-KILL", &pid.to_string()]).status();
        }
        pids.len()
    }

    fn sleep(&self, time: Duration) {
        std::thread::sleep(time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_processes_running_from_inside_the_bundle_are_picked() {
        let ps = "  101 /Applications/Eos.app/Contents/MacOS/Eos\n  102 /Applications/Eos.app/Contents/Frameworks/Eos Helper.app/Contents/MacOS/Eos Helper\n  103 /Applications/Eos.app.bak/Contents/MacOS/Eos\n  104 /usr/bin/vim\n  105 /Applications/Eos.app/Contents/MacOS/eos-apply\n";
        assert_eq!(pids_in(ps, &[Path::new("/Applications/Eos.app")], 105), vec![101, 102]);
        assert!(pids_in(ps, &[Path::new("/Applications/Other.app")], 0).is_empty());
        let both = [Path::new("/Applications/Other.app"), Path::new("/Applications/Eos.app.bak")];
        assert_eq!(pids_in(ps, &both, 0), vec![103]);
    }

    #[test]
    fn this_test_process_is_alive_and_a_spent_pid_is_not() {
        let system = MacSystem;
        assert!(system.process_alive(std::process::id()));
        let mut child = Command::new("/usr/bin/true").spawn().expect("spawn");
        let pid = child.id();
        child.wait().expect("reaped");
        assert!(!system.process_alive(pid));
    }
}
