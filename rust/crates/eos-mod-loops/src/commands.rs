//! A goal's verify commands: `sh -c <line>` in the worker's folder, exit 0
//! meaning met (`infra/src/goalcheck/runShell.ts`, `MemoCommandRunner.ts`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use eos_core::BoxFuture;
use eos_kit_proc::{Command, Overflow, Runner};

/// A verify may run a whole test suite; past this it counts as failed.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Output kept of one command; the judge's prompt cuts it further.
const MAX_OUTPUT: usize = 1024 * 1024;

/// How a command ended: its exit code (non-zero when it could not run or
/// timed out) and what it printed, stdout then stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub exit_code: i32,
    pub output: String,
}

/// Runs one command line in a folder. Dropping the future ends the command.
pub trait VerifyCommands: Send + Sync + 'static {
    fn run<'a>(&'a self, cwd: &'a Path, line: &'a str) -> BoxFuture<'a, CommandResult>;
}

/// The command lines run by the system's script shell, without a profile.
pub struct ShellCommands {
    runner: Runner,
    /// `None`: no POSIX shell on this system.
    shell: Option<PathBuf>,
}

impl std::fmt::Debug for ShellCommands {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellCommands").field("shell", &self.shell).finish_non_exhaustive()
    }
}

impl ShellCommands {
    pub fn new(runner: Runner, shell: Option<PathBuf>) -> Self {
        Self { runner, shell }
    }
}

fn combine(stdout: &str, stderr: &str) -> String {
    [stdout, stderr].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n").trim().to_owned()
}

impl VerifyCommands for ShellCommands {
    fn run<'a>(&'a self, cwd: &'a Path, line: &'a str) -> BoxFuture<'a, CommandResult> {
        Box::pin(async move {
            let Some(shell) = &self.shell else {
                return CommandResult { exit_code: 127, output: "no POSIX shell on this system".into() };
            };
            let command =
                Command::shell(shell, line).cwd(cwd).timeout(VERIFY_TIMEOUT).max_output(MAX_OUTPUT, Overflow::Truncate);
            match self.runner.run(command).await {
                Ok(out) => {
                    let output = combine(&out.stdout_text(), &out.stderr_text());
                    let exit_code = if out.timed_out { 1 } else { out.exit_code.unwrap_or(1) };
                    let output = if out.timed_out && output.is_empty() { "timed out".to_owned() } else { output };
                    CommandResult { exit_code, output }
                }
                Err(e) => CommandResult { exit_code: 1, output: e.to_string() },
            }
        })
    }
}

/// One check's commands: each distinct command line and folder runs once, the
/// verify pass and the judge's evidence share it. Freed with the check. A
/// command cancelled half-way is not kept, so a later ask runs it.
pub(crate) struct Memo {
    commands: Arc<dyn VerifyCommands>,
    done: Mutex<HashMap<(PathBuf, String), CommandResult>>,
}

impl Memo {
    pub(crate) fn new(commands: Arc<dyn VerifyCommands>) -> Self {
        Self { commands, done: Mutex::default() }
    }

    pub(crate) async fn run(&self, cwd: &Path, line: &str) -> CommandResult {
        let key = (cwd.to_owned(), line.to_owned());
        if let Some(hit) = self.done.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
            return hit.clone();
        }
        let result = self.commands.run(cwd, line).await;
        self.done.lock().unwrap_or_else(PoisonError::into_inner).insert(key, result.clone());
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_stdout_then_stderr_trimmed() {
        assert_eq!(combine("out\n", ""), "out");
        assert_eq!(combine("a", "b\n"), "a\nb");
        assert_eq!(combine("", ""), "");
    }
}
