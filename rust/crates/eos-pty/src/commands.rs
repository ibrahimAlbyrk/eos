//! One-shot command lines in the user's shell, and finding their `claude`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_core::BoxFuture;
use eos_core::terminal::{ClaudeProgram, CommandEvents, CommandExit, RunningCommand, ShellCommands};
use eos_kit_proc::{Command, Event, Overflow, Runner};
use eos_platform::TerminalShell;
use tokio::sync::Notify;

use crate::utf8::Utf8Stream;

/// Runs command lines in the user's own shell with their profile (aliases,
/// functions, `PATH` edits), without a terminal. Needs the async runtime.
#[derive(Debug, Clone)]
pub struct ShellRunner {
    runner: Runner,
    shell: &'static dyn TerminalShell,
    script_shell: Option<PathBuf>,
}

impl ShellRunner {
    /// `script_shell` is the system's POSIX `sh`, used to give a command one
    /// output stream: what it writes to stdout and stderr then arrives in the
    /// order written. Without it the two streams are read side by side.
    pub fn new(runner: Runner, shell: &'static dyn TerminalShell, script_shell: Option<PathBuf>) -> Self {
        Self { runner, shell, script_shell }
    }

    fn command(&self, line: &str) -> Command {
        let argv = self.shell.run(line);
        match &self.script_shell {
            // `sh` points stderr at stdout, then becomes the user's shell.
            Some(sh) => Command::new(sh).args(["-c", "exec 2>&1; exec \"$@\"", "sh", &argv.file]).args(&argv.args),
            None => Command::new(&argv.file).args(&argv.args),
        }
    }
}

struct Running {
    stop: Notify,
}

impl RunningCommand for Running {
    fn kill(&self) {
        self.stop.notify_one();
    }
}

impl ShellCommands for ShellRunner {
    fn folder(&self, path: &str) -> Option<String> {
        let path = eos_platform::expand_path(path);
        (!path.is_empty() && std::path::Path::new(&path).exists()).then_some(path)
    }

    fn run(
        &self,
        cwd: &str,
        command: &str,
        timeout: Duration,
        mut events: Box<dyn CommandEvents>,
    ) -> Arc<dyn RunningCommand> {
        let running = Arc::new(Running { stop: Notify::new() });
        let spawned = self.runner.spawn(self.command(command).cwd(cwd).timeout(timeout));
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                events.failed(e.to_string());
                return running;
            }
        };
        let handle = running.clone();
        tokio::spawn(async move {
            let mut killed = false;
            // One decoder per stream: a character cut by a read belongs to its own.
            let (mut stdout, mut stderr) = (Utf8Stream::default(), Utf8Stream::default());
            let text = |events: &mut Box<dyn CommandEvents>, piece: String| {
                if !piece.is_empty() {
                    events.output(&piece);
                }
            };
            loop {
                let event = tokio::select! {
                    event = child.next() => event,
                    () = handle.stop.notified(), if !killed => {
                        killed = true;
                        child.kill();
                        continue;
                    }
                };
                match event {
                    Some(Event::Stdout(bytes)) => text(&mut events, stdout.push(&bytes)),
                    Some(Event::Stderr(bytes)) => text(&mut events, stderr.push(&bytes)),
                    Some(Event::Exit(exit)) => {
                        text(&mut events, stdout.finish());
                        text(&mut events, stderr.finish());
                        // The whole tree is ended with one signal, by a kill or at the deadline.
                        let signal = exit.code.is_none().then(|| "SIGKILL".to_owned());
                        events.exit(CommandExit { code: exit.code, signal, timed_out: exit.timed_out });
                        return;
                    }
                    None => {
                        events.failed("the command was lost".to_owned());
                        return;
                    }
                }
            }
        });
        running
    }
}

/// How long a found `claude` is trusted before it is looked for again.
const FOUND_FOR: Duration = Duration::from_secs(300);
/// The shell gets this long to answer (it loads the user's profile).
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Finds the user's Claude Code the way their terminal would: by asking
/// their shell, then in the places its installers put it.
#[derive(Debug)]
pub struct ClaudeLocator {
    runner: Runner,
    shell: &'static dyn TerminalShell,
    home: Option<PathBuf>,
    found: Mutex<Option<(String, std::time::Instant)>>,
}

impl ClaudeLocator {
    pub fn new(runner: Runner, shell: &'static dyn TerminalShell, home: Option<PathBuf>) -> Self {
        Self { runner, shell, home, found: Mutex::new(None) }
    }

    /// Where Claude Code's installers and the common package managers put it.
    fn usual_places(&self) -> Vec<PathBuf> {
        let mut places = Vec::new();
        if let Some(home) = &self.home {
            for rel in [".local/bin", ".claude/local", ".claude/bin", ".npm-global/bin", ".bun/bin", ".volta/bin"] {
                places.push(home.join(rel).join("claude"));
            }
        }
        places.extend(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
        places
    }

    async fn look(&self) -> Option<String> {
        let argv = self.shell.run("command -v claude");
        let probe =
            Command::new(&argv.file).args(&argv.args).timeout(PROBE_TIMEOUT).max_output(4096, Overflow::Truncate);
        if let Ok(out) = self.runner.run(probe).await
            && out.success()
            && !out.stdout_text().trim().is_empty()
        {
            return Some("claude".to_owned());
        }
        let places = self.usual_places();
        tokio::task::spawn_blocking(move || places.into_iter().find(|p| is_executable(p)))
            .await
            .ok()
            .flatten()
            .map(|path| path.to_string_lossy().into_owned())
    }
}

fn is_executable(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

impl ClaudeProgram for ClaudeLocator {
    fn locate(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let cached = self.found.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some((word, at)) = cached
                && at.elapsed() < FOUND_FOR
            {
                return Some(word);
            }
            let word = self.look().await;
            // Only a hit is remembered: after installing it, the next try finds it.
            *self.found.lock().unwrap_or_else(|p| p.into_inner()) =
                word.clone().map(|w| (w, std::time::Instant::now()));
            word
        })
    }
}
