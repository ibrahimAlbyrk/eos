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

/// The id of the user this process runs as; `None` where users have no numeric id.
pub fn user_id() -> Option<u32> {
    #[cfg(unix)]
    {
        Some(rustix::process::getuid().as_raw())
    }
    #[cfg(not(unix))]
    {
        None
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

// The user's clock is read from the zone's own rules (the `TZ` variable, else the system's
// zone file), as `localtime` reads them, in this process: no program is started, so these
// are cheap enough for any thread, an async worker included.

/// The instant `epoch_ms` on the user's clock; `None` for an instant out of range.
fn local(epoch_ms: i64) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(epoch_ms).single()
}

/// Hours and minutes of `epoch_ms` on the user's clock (`16:40`).
pub fn local_hour_minute(epoch_ms: i64) -> Option<String> {
    local(epoch_ms).map(|at| at.format("%H:%M").to_string())
}

/// Minutes east of UTC on the user's clock at `epoch_ms`, daylight saving included.
pub fn local_utc_offset_minutes(epoch_ms: i64) -> Option<i32> {
    use chrono::Offset;
    local(epoch_ms).map(|at| at.offset().fix().local_minus_utc() / 60)
}

/// The name of the user's time zone (`Europe/Istanbul`): the `TZ` variable
/// when it names one, else where the system's zone file points.
pub fn local_zone_name() -> Option<String> {
    let named = std::env::var("TZ").ok().map(|tz| tz.trim_start_matches(':').to_owned());
    if let Some(name) = named.filter(|name| !name.is_empty() && !name.starts_with('/')) {
        return Some(name);
    }
    let target = std::fs::read_link("/etc/localtime").ok()?;
    let target = target.to_string_lossy();
    let (_, name) = target.split_once("zoneinfo/")?;
    (!name.is_empty()).then(|| name.to_owned())
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
    fn the_clock_reads_as_the_systems_date_does() {
        // Both sides of a daylight saving change in many zones, and today.
        for at in [1_711_846_800_000_i64, 1_729_990_800_000, 1_800_000_000_000] {
            let seconds = (at / 1_000).to_string();
            let date = |format: &str| {
                let out = Command::new("/bin/date").args(["-r", &seconds, format]).output().expect("date");
                String::from_utf8_lossy(&out.stdout).trim().to_owned()
            };
            assert_eq!(local_hour_minute(at), Some(date("+%H:%M")), "{at}");
            let offset = date("+%z");
            let (sign, hours, minutes) = (&offset[..1], &offset[1..3], &offset[3..5]);
            let number = |digits: &str| digits.parse::<i32>().expect("digits");
            let minutes_east = number(hours) * 60 + number(minutes);
            assert_eq!(
                local_utc_offset_minutes(at),
                Some(if sign == "-" { -minutes_east } else { minutes_east }),
                "{at}"
            );
        }
        // The system answers for any instant.
        assert!(local_utc_offset_minutes(1_800_000_000_000).is_some_and(|m| m.abs() <= 14 * 60));
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

/// How many file descriptors this process has open, or `None` where the
/// system does not list them. `/dev/fd` names each one; listing it holds one
/// more for as long as the listing takes.
pub fn open_fd_count() -> Option<u64> {
    #[cfg(unix)]
    {
        let listed = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
        Some(listed.saturating_sub(1))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The most file descriptors this process may open (its soft `RLIMIT_NOFILE`),
/// or `None` where there is no such limit.
pub fn soft_fd_limit() -> Option<u64> {
    #[cfg(unix)]
    {
        rustix::process::getrlimit(rustix::process::Resource::Nofile).current
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(test)]
mod fd_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_process_counts_its_descriptors_below_its_limit() {
        // The count is the whole process's, and other tests open and close
        // files meanwhile: comparing two counts would race with them. What
        // this test holds itself is in every count, whatever they do.
        const HELD: u64 = 32;
        let open = open_fd_count().expect("unix lists descriptors");
        assert!(open >= 3, "stdin, stdout and stderr at least: {open}");
        let held: Vec<std::fs::File> =
            (0..HELD).map(|_| std::fs::File::open("/dev/null").expect("a descriptor")).collect();
        let counted = open_fd_count().expect("a count");
        assert!(counted >= HELD + 3, "the {HELD} files held here are counted: {counted}");
        drop(held);
        assert!(soft_fd_limit().is_none_or(|limit| limit > open));
    }
}
