//! How a script reaches the Mail app: [`Script`] runs one JavaScript for
//! Automation program with its input as JSON and reads back the JSON it
//! prints. [`Osascript`] is the real one; only the host hands it in, so a
//! test, a dev run or a replay never drives the user's Mail.

use std::time::Duration;

use eos_core::BoxFuture;
use eos_kit_proc::{Command, Env, Runner};
use serde_json::Value;

use crate::jxa;

/// How long one `osascript` may run before it is ended.
const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(60);
/// The most a script may print.
const OSASCRIPT_MAX_OUTPUT: usize = 8 * 1024 * 1024;
/// What macOS answers when the user has not allowed Eos to drive the app
/// (`errAEEventNotPermitted`).
pub const NOT_PERMITTED: i64 = -1743;

/// Why a script gave no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptError {
    /// macOS refused the Apple Event (-1743): the user has not allowed it.
    Denied,
    /// The script failed with this Apple Event error code, when it said one.
    Failed(Option<i64>),
    /// It ran out of time.
    Timeout,
    /// What it printed is no JSON.
    BadOutput,
}

/// The programs the capability runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Program {
    /// Mail's accounts: `{accounts}`.
    Check,
    /// Inbox mail received after `since`: `{messages: [{messageId, subject, from, receivedAt, read}]}`.
    Recent,
    /// One inbox mail by `messageId`, with its text.
    Read,
    /// One mail to `to`, with a page's html, images and PDF: `{sent}`.
    Send,
}

impl Program {
    fn source(self) -> &'static str {
        match self {
            Program::Check => jxa::CHECK,
            Program::Recent => jxa::RECENT,
            Program::Read => jxa::READ,
            Program::Send => jxa::SEND,
        }
    }
}

/// Runs a JavaScript for Automation program with `input`, and answers the
/// JSON it returns.
pub trait Script: Send + Sync {
    fn run(&self, program: Program, input: Value) -> BoxFuture<'_, Result<Value, ScriptError>>;
}

/// `osascript -l JavaScript` with no environment of the user's.
pub struct Osascript {
    runner: Runner,
}

impl std::fmt::Debug for Osascript {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Osascript").finish_non_exhaustive()
    }
}

impl Osascript {
    pub fn new(runner: Runner) -> Self {
        Self { runner }
    }

    async fn run_once(&self, program: Program, input: Value) -> Result<Value, ScriptError> {
        let command = Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", &jxa::with_input(program.source())])
            .stdin(input.to_string())
            .env(Env::empty())
            .timeout(OSASCRIPT_TIMEOUT)
            .max_output(OSASCRIPT_MAX_OUTPUT, eos_kit_proc::Overflow::Truncate);
        let output = self.runner.run(command).await.map_err(|_| ScriptError::Failed(None))?;
        if output.timed_out {
            return Err(ScriptError::Timeout);
        }
        if !output.success() {
            return Err(failure_of(&output.stderr_text()));
        }
        serde_json::from_str(output.stdout_text().trim()).map_err(|_| ScriptError::BadOutput)
    }
}

impl Script for Osascript {
    fn run(&self, program: Program, input: Value) -> BoxFuture<'_, Result<Value, ScriptError>> {
        Box::pin(self.run_once(program, input))
    }
}

/// What `osascript`'s error line says: it ends with the code in brackets,
/// as in `execution error: Not authorized to send Apple events to Mail. (-1743)`.
pub(crate) fn failure_of(stderr: &str) -> ScriptError {
    let code =
        stderr.trim().strip_suffix(')').and_then(|rest| rest.rsplit_once('(')).and_then(|(_, code)| code.parse().ok());
    match code {
        Some(NOT_PERMITTED) => ScriptError::Denied,
        code => ScriptError::Failed(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_error_code_at_the_end_of_osascripts_line_is_read() {
        let denied = "execution error: Not authorized to send Apple events to Mail. (-1743)\n";
        assert_eq!(failure_of(denied), ScriptError::Denied);
        assert_eq!(
            failure_of("execution error: Mail got an error: Can't get message. (-1728)"),
            ScriptError::Failed(Some(-1728))
        );
        assert_eq!(failure_of("something else"), ScriptError::Failed(None));
    }
}
