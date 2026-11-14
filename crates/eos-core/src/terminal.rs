//! Terminals: a shell in a PTY, the mirror of its screen, one-shot command
//! lines, and where the user's `claude` is.

use std::sync::Arc;

use eos_domain::claude_transcript::TranscriptView;

use crate::{BoxFuture, Error};

/// A terminal to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySpawn {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Run in the login shell first; the shell stays open after it.
    pub command: Option<String>,
    /// The child's environment; `None`: this process's own. The terminal's
    /// identity (`TERM`, …) is set on top either way.
    pub env: Option<Vec<(String, String)>>,
}

/// Where a terminal's output and its end go. Both are called from the
/// terminal's own reader thread, in order. `output` may block: nothing more
/// is read from the terminal meanwhile, so the program in it waits.
pub trait PtyEvents: Send + 'static {
    /// Whole characters only: a character cut by a read is held back.
    fn output(&mut self, text: &str);
    /// The shell ended; nothing follows. `code` is its exit code, 0 when a
    /// signal ended it.
    fn exit(&mut self, code: i32);
}

/// A running terminal. Dropping the last handle ends the shell.
pub trait Pty: Send + Sync + 'static {
    fn write(&self, data: &[u8]);
    fn resize(&self, cols: u16, rows: u16);
    /// Hangs the shell up; its end arrives through [`PtyEvents::exit`].
    fn kill(&self);
    /// The name of the program in the terminal's foreground (the shell, or
    /// what it runs). Asks the system: call it off the async threads.
    fn foreground(&self) -> Option<String>;
}

/// A headless terminal fed what the clients are sent.
pub trait Screen: Send + 'static {
    fn write(&mut self, text: &str);
    fn resize(&mut self, cols: u16, rows: u16);
    /// What a client writes into a fresh terminal of the same size to see
    /// this screen: history, screen, cursor, modes.
    fn snapshot(&self) -> String;
}

pub trait Terminals: Send + Sync + 'static {
    /// Starts the user's login shell in a PTY.
    fn spawn(&self, spec: PtySpawn, events: Box<dyn PtyEvents>) -> Result<Arc<dyn Pty>, Error>;
    fn screen(&self, cols: u16, rows: u16) -> Box<dyn Screen>;
    /// A command line for the terminal's shell that runs `b` only when `a` fails.
    fn or_else(&self, a: &str, b: &str) -> String;
    /// A program in a terminal can write to that terminal's device, so a
    /// hook run by it can report back through the terminal's output.
    fn tty_hooks(&self) -> bool;
}

/// How a one-shot command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandExit {
    /// `None` when a signal ended it.
    pub code: Option<i32>,
    /// The signal's name (`SIGKILL`).
    pub signal: Option<String>,
    /// It ran into the deadline it was given.
    pub timed_out: bool,
}

/// What a one-shot command reports: its output as it arrives (stdout and
/// stderr, each in order), then exactly one of `exit` or `failed`.
pub trait CommandEvents: Send + 'static {
    /// Whole characters only, as with a terminal's output.
    fn output(&mut self, text: &str);
    fn exit(&mut self, exit: CommandExit);
    /// It could not be started.
    fn failed(&mut self, reason: String);
}

/// A command that is running.
pub trait RunningCommand: Send + Sync + 'static {
    /// Ends the command and everything it started.
    fn kill(&self);
}

/// Command lines run in the user's shell with their profile, without a terminal.
pub trait ShellCommands: Send + Sync + 'static {
    /// The folder a command would run in — `path` with a leading `~`
    /// expanded — or `None` when there is no such folder. Asks the system.
    fn folder(&self, path: &str) -> Option<String>;
    /// Starts `command`. Needs the async runtime.
    fn run(
        &self,
        cwd: &str,
        command: &str,
        timeout: std::time::Duration,
        events: Box<dyn CommandEvents>,
    ) -> Arc<dyn RunningCommand>;
}

/// The user's own Claude Code.
pub trait ClaudeProgram: Send + Sync + 'static {
    /// The word a terminal's shell runs it by (`claude`, or a path when the
    /// shell does not find it itself); `None` when it is not installed.
    fn locate(&self) -> BoxFuture<'_, Option<String>>;
}

/// The environment a Code-view `claude` starts with: the app composes it so
/// that Claude Code reads Eos's own sign-in, never the user's. `None` is this
/// process's environment.
pub trait ClaudeLaunchEnv: Send + Sync + 'static {
    fn env(&self) -> BoxFuture<'_, Option<Vec<(String, String)>>>;
}

/// Claude Code's own record of its conversations (`~/.claude/projects/…`).
pub trait ClaudeTranscripts: Send + Sync + 'static {
    /// The transcript of conversation `session_id`, started in folder `cwd`.
    fn open(&self, cwd: &str, session_id: &str) -> Box<dyn TranscriptFile>;
}

/// One transcript, read while Claude appends to it. Reads the file: call it
/// off the async threads.
pub trait TranscriptFile: Send + 'static {
    /// The conversation so far; `None` while the file cannot be read (it may
    /// not exist yet). A read parses only the lines completed since the one
    /// before, and gives what a fresh parse of the whole file would.
    fn read(&mut self) -> Option<TranscriptView>;
    /// The file's size and modification time (epoch milliseconds), to notice
    /// a change without reading; `None` while there is no file.
    fn stamp(&self) -> Option<(u64, i64)>;
}
