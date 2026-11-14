use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use crate::env::Env;

/// A command that hangs is ended after this long unless it says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Bytes kept of each of stdout and stderr.
pub const DEFAULT_MAX_OUTPUT: usize = 4 * 1024 * 1024;

/// What happens when a stream prints more than the cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Overflow {
    /// Keep the first bytes up to the cap, drop the rest, let the command finish.
    #[default]
    Truncate,
    /// End the command and fail: the caller needs all of the output or none.
    Fail,
}

/// What to run and within which bounds.
#[derive(Debug, Clone)]
pub struct Command {
    pub(crate) program: OsString,
    pub(crate) args: Vec<OsString>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: Env,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) stdin_open: bool,
    pub(crate) timeout: Option<Duration>,
    pub(crate) max_output: usize,
    pub(crate) overflow: Overflow,
}

impl Command {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Env::inherit(),
            stdin: None,
            stdin_open: false,
            timeout: Some(DEFAULT_TIMEOUT),
            max_output: DEFAULT_MAX_OUTPUT,
            overflow: Overflow::Truncate,
        }
    }

    /// `shell -c line`: one command line in a shell (the platform's script shell).
    pub fn shell(shell: impl Into<OsString>, line: impl Into<OsString>) -> Self {
        Self::new(shell).arg("-c").arg(line)
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    pub fn env(mut self, env: Env) -> Self {
        self.env = env;
        self
    }

    /// Bytes written to the child's stdin, which is then closed. Without this
    /// the child reads end-of-file at once instead of waiting on a pipe.
    pub fn stdin(mut self, input: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(input.into());
        self
    }

    /// Keeps the child's stdin open for a conversation: the caller writes to
    /// it through [`Child::stdin`](crate::Child::stdin) ([`Runner::spawn`](crate::Runner::spawn) only).
    pub fn stdin_open(mut self) -> Self {
        self.stdin_open = true;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// For a command that legitimately runs as long as the caller listens.
    pub fn no_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }

    /// The cap on each of stdout and stderr ([`Runner::run`](crate::Runner::run) only).
    pub fn max_output(mut self, bytes: usize, overflow: Overflow) -> Self {
        self.max_output = bytes;
        self.overflow = overflow;
        self
    }
}
