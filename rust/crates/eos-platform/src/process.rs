//! Process trees. A child started through [`isolate_command`] leads its own
//! process group, so one signal ends it and everything it started.
//!
//! These free functions have plain `fn` types on purpose: `eos-kit-proc`
//! takes them as values, so it needs no dependency on this crate.

use std::process::Command;

use crate::error::Error;

/// Makes the command's child the leader of a new process group.
pub fn isolate_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

/// SIGKILLs the process group `pid` leads. The signal reaches the processes in
/// the group at that instant: one being forked right then is missed. A caller
/// that owns the child reaps it, then calls again until this reports
/// [`Error::NoSuchProcess`] (`eos-kit-proc` does).
pub fn kill_process_tree(pid: u32) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use rustix::process::{Pid, Signal, kill_process_group};
        // Group 1 would be kill(-1): every process the user owns.
        if pid <= 1 {
            return Err(Error::NoSuchProcess(pid));
        }
        let group = i32::try_from(pid).ok().and_then(Pid::from_raw).ok_or(Error::NoSuchProcess(pid))?;
        kill_process_group(group, Signal::KILL).map_err(|errno| match errno {
            rustix::io::Errno::SRCH => Error::NoSuchProcess(pid),
            other => Error::Io(other.into()),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err(Error::Unsupported("ending a process tree"))
    }
}

/// A process with that id exists (it may be a zombie nobody has reaped).
pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use rustix::process::{Pid, test_kill_process};
        match i32::try_from(pid).ok().and_then(Pid::from_raw) {
            // EPERM: it exists and belongs to someone else.
            Some(pid) => !matches!(test_kill_process(pid), Err(rustix::io::Errno::SRCH)),
            None => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use super::*;

    fn gone_within(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn killing_the_tree_ends_a_grandchild_the_shell_backgrounded() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & echo $!; wait"]).stdout(Stdio::piped());
        isolate_command(&mut command);
        let mut child = command.spawn().expect("spawn");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout")).read_line(&mut line).expect("grandchild pid");
        let grandchild: u32 = line.trim().parse().expect("a pid");
        assert!(process_alive(grandchild));

        kill_process_tree(child.id()).expect("kill");
        child.wait().expect("reap");
        assert!(gone_within(grandchild, Duration::from_secs(3)), "the grandchild died with the group");
        assert!(matches!(kill_process_tree(child.id()), Err(Error::NoSuchProcess(_))));
    }

    #[test]
    fn an_impossible_pid_is_no_process() {
        assert!(matches!(kill_process_tree(0), Err(Error::NoSuchProcess(0))));
        // Refused before any signal: -1 addresses every process of the user.
        assert!(matches!(kill_process_tree(1), Err(Error::NoSuchProcess(1))));
        assert!(matches!(kill_process_tree(u32::MAX), Err(Error::NoSuchProcess(_))));
        assert!(!process_alive(0));
    }
}
