//! A shell in a PTY (`spawner/pty-host.ts`, there over node-pty; here over
//! `portable-pty`).
//!
//! Three threads per terminal: one reads its output, one waits for the shell
//! to end, one writes its input. Output is handed over on the reader thread,
//! so a consumer that blocks holds the terminal back instead of piling up
//! output. Input waits in a bounded queue and never blocks its caller.

use std::io::{Read, Write};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use eos_core::Error;
use eos_core::terminal::{Pty, PtyEvents, PtySpawn, Screen, Terminals};
use eos_platform::TerminalShell;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::utf8::Utf8Stream;

/// Bytes asked of the terminal per read. Also the most one piece of output holds.
const READ_CHUNK: usize = 32 * 1024;
/// Pieces of input waiting for a program that is not reading. Past it, input is dropped.
const INPUT_QUEUE: usize = 1024;
/// After the shell ended, how long its last output may still arrive before
/// the end is reported (something it started can hold the terminal open).
const DRAIN_GRACE: Duration = Duration::from_millis(500);
/// A shell that was hung up and is still there after this is killed.
const HANGUP_GRACE: Duration = Duration::from_secs(2);

/// The identity every terminal gets on top of its environment. An inherited
/// `TERM_PROGRAM` (the app started from another terminal) would make programs
/// apply that terminal's quirks; `COLORTERM` keeps true colour on;
/// `FORCE_HYPERLINK` makes tools emit clickable links.
pub fn terminal_env(base: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    const OURS: [(&str, &str); 4] =
        [("TERM", "xterm-256color"), ("TERM_PROGRAM", "eos"), ("COLORTERM", "truecolor"), ("FORCE_HYPERLINK", "1")];
    let mut env: Vec<(String, String)> = base
        .into_iter()
        .filter(|(name, _)| name != "TERM_PROGRAM_VERSION" && !OURS.iter().any(|(ours, _)| ours == name))
        .collect();
    env.extend(OURS.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())));
    env
}

fn process_env() -> Vec<(String, String)> {
    std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}

/// Terminals on this computer: the user's login shell in a PTY, and the
/// screen mirror.
#[derive(Debug)]
pub struct PtyTerminals {
    shell: &'static dyn TerminalShell,
}

impl PtyTerminals {
    pub fn new(shell: &'static dyn TerminalShell) -> Self {
        Self { shell }
    }
}

impl Terminals for PtyTerminals {
    fn spawn(&self, spec: PtySpawn, events: Box<dyn PtyEvents>) -> Result<Arc<dyn Pty>, Error> {
        let argv = self.shell.interactive(spec.command.as_deref(), false);
        let failed = |what: &str, e: &dyn std::fmt::Display| Error::Storage(format!("terminal: {what}: {e}"));

        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| failed("no PTY", &e))?;
        let mut command = CommandBuilder::new(&argv.file);
        command.args(&argv.args);
        command.cwd(&spec.cwd);
        command.env_clear();
        for (name, value) in terminal_env(spec.env.unwrap_or_else(process_env)) {
            command.env(name, value);
        }
        let mut child = pair.slave.spawn_command(command).map_err(|e| failed(&argv.file, &e))?;
        // Ours must close, or the terminal never reports its end.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| failed("no reader", &e))?;
        let writer = pair.master.take_writer().map_err(|e| failed("no writer", &e))?;

        let shared = Arc::new(Shared {
            state: Mutex::new(State { events: Some(events), reader_done: false, exited: false }),
            changed: Condvar::new(),
        });
        let pid = child.process_id();
        let killer = child.clone_killer();
        let (input, queued) = sync_channel::<Vec<u8>>(INPUT_QUEUE);

        let thread = |name: &str| std::thread::Builder::new().name(format!("eos-pty-{name}"));
        let spawned = (|| {
            let for_reader = shared.clone();
            thread("read").spawn(move || read_output(reader, &for_reader))?;
            let for_waiter = shared.clone();
            thread("wait").spawn(move || {
                // A signal's "exit code" is 0, as node-pty reports it.
                let code = match child.wait() {
                    Ok(status) if status.signal().is_none() => i32::try_from(status.exit_code()).unwrap_or(1),
                    _ => 0,
                };
                for_waiter.shell_ended(code);
            })?;
            thread("write").spawn(move || write_input(writer, &queued))?;
            Ok::<(), std::io::Error>(())
        })();
        if let Err(e) = spawned {
            let mut killer = killer;
            let _ = killer.kill();
            return Err(failed("no thread", &e));
        }

        Ok(Arc::new(HostPty { master: Mutex::new(pair.master), input, killer: Mutex::new(killer), pid, shared }))
    }

    fn screen(&self, cols: u16, rows: u16) -> Box<dyn Screen> {
        Box::new(crate::Screen::new(cols, rows))
    }

    fn or_else(&self, a: &str, b: &str) -> String {
        self.shell.or_else(a, b)
    }

    fn tty_hooks(&self) -> bool {
        self.shell.tty_hooks()
    }
}

impl Screen for crate::Screen {
    fn write(&mut self, text: &str) {
        crate::Screen::write(self, text);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        crate::Screen::resize(self, cols, rows);
    }

    fn snapshot(&self) -> String {
        crate::Screen::snapshot(self)
    }
}

struct State {
    /// Taken when the end is reported: nothing is delivered after it.
    events: Option<Box<dyn PtyEvents>>,
    reader_done: bool,
    exited: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    // The state stays valid at every step, so a poisoned lock is safe to keep using.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn output(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        // Held across the call on purpose: the end must not overtake output.
        if let Some(events) = self.state().events.as_mut() {
            events.output(text);
        }
    }

    fn reader_finished(&self) {
        self.state().reader_done = true;
        self.changed.notify_all();
    }

    /// The shell is gone: let its last output arrive, then report the end.
    fn shell_ended(&self, code: i32) {
        let mut state = self.state();
        state.exited = true;
        self.changed.notify_all();
        let (mut state, _) =
            self.changed.wait_timeout_while(state, DRAIN_GRACE, |s| !s.reader_done).unwrap_or_else(|p| p.into_inner());
        if let Some(mut events) = state.events.take() {
            drop(state);
            events.exit(code);
        }
    }

    fn exited_within(&self, timeout: Duration) -> bool {
        let state = self.state();
        let (state, _) =
            self.changed.wait_timeout_while(state, timeout, |s| !s.exited).unwrap_or_else(|p| p.into_inner());
        state.exited
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, shared: &Shared) {
    let mut decoder = Utf8Stream::default();
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            // End of file, or EIO once the last program closed the terminal.
            Ok(0) | Err(_) => break,
            Ok(n) => shared.output(&decoder.push(&buf[..n])),
        }
    }
    shared.output(&decoder.finish());
    shared.reader_finished();
}

fn write_input(mut writer: Box<dyn Write + Send>, queued: &Receiver<Vec<u8>>) {
    while let Ok(data) = queued.recv() {
        if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
            break;
        }
    }
}

struct HostPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: SyncSender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    shared: Arc<Shared>,
}

impl HostPty {
    fn hang_up(&self) {
        if self.shared.state().exited {
            return;
        }
        let _ = self.killer.lock().unwrap_or_else(|p| p.into_inner()).kill();
    }
}

impl Pty for HostPty {
    fn write(&self, data: &[u8]) {
        match self.input.try_send(data.to_vec()) {
            Ok(()) | Err(TrySendError::Disconnected(_)) => {}
            Err(TrySendError::Full(_)) => {
                tracing::warn!("terminal input dropped: the program in it is not reading");
            }
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
        if let Err(e) = self.master.lock().unwrap_or_else(|p| p.into_inner()).resize(size) {
            tracing::debug!(error = %e, "terminal resize failed");
        }
    }

    fn kill(&self) {
        self.hang_up();
    }

    fn foreground(&self) -> Option<String> {
        let leader = foreground_pid(self.master.lock().unwrap_or_else(|p| p.into_inner()).as_ref())?;
        let out = std::process::Command::new("ps").args(["-o", "ucomm=", "-p", &leader.to_string()]).output().ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!name.is_empty()).then_some(name)
    }
}

#[cfg(unix)]
fn foreground_pid(master: &(dyn MasterPty + Send)) -> Option<i32> {
    master.process_group_leader()
}

#[cfg(not(unix))]
fn foreground_pid(_master: &(dyn MasterPty + Send)) -> Option<i32> {
    None
}

impl Drop for HostPty {
    // Nothing holds the terminal any more: the shell must not outlive it.
    fn drop(&mut self) {
        self.hang_up();
        let (shared, pid) = (self.shared.clone(), self.pid);
        let reap = move || {
            if !shared.exited_within(HANGUP_GRACE)
                && let Some(pid) = pid
            {
                kill_shell(pid);
            }
        };
        if std::thread::Builder::new().name("eos-pty-reap".to_owned()).spawn(reap.clone()).is_err() {
            reap();
        }
    }
}

/// SIGKILL to the shell this terminal started (never a group, never a name).
#[cfg(unix)]
fn kill_shell(pid: u32) {
    use rustix::process::{Pid, Signal, kill_process};
    if pid > 1
        && let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw)
    {
        let _ = kill_process(pid, Signal::KILL);
    }
}

#[cfg(not(unix))]
fn kill_shell(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terminal_identity_replaces_an_inherited_one() {
        let env = terminal_env([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("TERM".to_owned(), "dumb".to_owned()),
            ("TERM_PROGRAM".to_owned(), "ghostty".to_owned()),
            ("TERM_PROGRAM_VERSION".to_owned(), "1.2".to_owned()),
        ]);
        let get = |name: &str| env.iter().filter(|(n, _)| n == name).map(|(_, v)| v.as_str()).collect::<Vec<_>>();
        assert_eq!(get("PATH"), ["/bin"]);
        assert_eq!(get("TERM"), ["xterm-256color"]);
        assert_eq!(get("TERM_PROGRAM"), ["eos"]);
        assert_eq!(get("COLORTERM"), ["truecolor"]);
        assert_eq!(get("FORCE_HYPERLINK"), ["1"]);
        assert!(get("TERM_PROGRAM_VERSION").is_empty());
    }
}
