//! The terminal's `eos` command (07 §4.4). It sends one request to the running app's gateway
//! on `<shell data>/cli.sock` and prints the lines it answers until the exit code. When Eos
//! is not running, the command opens its own bundle hidden and waits for it.
//!
//! What reaches the system and the terminal goes through [`Terminal`] and [`Launcher`], so
//! the tests run it against a fake socket and never start an app.

pub mod args;

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use eos_contracts::cli::{CLI_STDIN_MAX_BYTES, CliFrame, CliRequest, exit};

use args::{Asked, HELP, parse};

/// The socket's name in the shell's data folder (as `eos_bridge::cli::SOCKET`).
pub const SOCKET: &str = "cli.sock";
/// How long a started app has to answer.
pub const START_WITHIN: Duration = Duration::from_secs(60);
const START_POLL: Duration = Duration::from_millis(250);

/// The terminal the command runs in.
pub trait Terminal {
    /// Text piped in; `None` when standard input is a terminal.
    fn piped(&mut self) -> Option<&mut dyn Read>;
    /// Whether the user can be asked (standard input and error are terminals).
    fn interactive(&self) -> bool;
    fn out(&mut self, line: &str);
    fn err(&mut self, line: &str);
    /// Asks a yes-or-no question on the terminal.
    fn confirm(&mut self, question: &str) -> bool;
}

/// Starts Eos hidden. `false`: there is no app to start (the command is not in a bundle).
pub trait Launcher {
    fn launch(&self) -> bool;
}

/// Where the command finds the app.
#[derive(Debug, Clone)]
pub struct Place {
    /// The shell's data folder, which holds the socket.
    pub shell_data: PathBuf,
    pub start_within: Duration,
}

/// Runs the command line; the code the process exits with.
pub fn run(args: &[String], cwd: &Path, place: &Place, terminal: &mut dyn Terminal, launcher: &dyn Launcher) -> i32 {
    let (mut request, takes_stdin) = match parse(args, cwd) {
        Ok(Asked::Help) => {
            terminal.out(HELP);
            return exit::OK;
        }
        Ok(Asked::Request { request, stdin }) => (request, stdin),
        Ok(Asked::MemoryHook { event }) => {
            memory_hook(&place.shell_data.join(SOCKET), event, terminal);
            return exit::OK;
        }
        Err(why) => {
            terminal.err(&why);
            return exit::REFUSED;
        }
    };
    if takes_stdin && let Some(piped) = terminal.piped() {
        match read_piped(piped) {
            Ok(text) => set_stdin(&mut request, text),
            Err(why) => {
                terminal.err(&why);
                return exit::REFUSED;
            }
        }
    }
    let socket = place.shell_data.join(SOCKET);
    if !reachable(&socket) {
        if !launcher.launch() {
            terminal.err("Eos is not running. Open Eos, then try again.");
            return exit::UNREACHABLE;
        }
        terminal.err("Starting Eos…");
        if !wait_until_reachable(&socket, place.start_within) {
            terminal.err("Eos did not start in time.");
            return exit::UNREACHABLE;
        }
    }
    loop {
        match ask(&socket, &request, terminal) {
            Ending::Exit(code) => return code,
            Ending::Confirm(text) => {
                let agreed = if terminal.interactive() {
                    terminal.confirm(&text)
                } else {
                    terminal.err(&format!("{text} Add --yes to start them."));
                    false
                };
                let CliRequest::Run(run) = &mut request else { return exit::REFUSED };
                if !agreed {
                    return exit::REFUSED;
                }
                run.yes = true;
            }
        }
    }
}

/// How long a Claude Code hook may hold the tool it runs before (04 G34).
pub const HOOK_WITHIN: Duration = Duration::from_millis(300);

/// A Claude Code hook: its input to the app, the app's answer to standard output. It never
/// starts the app and never says anything else: past 300 ms, or on any problem, it prints
/// nothing and the tool goes on as if Eos were not there.
fn memory_hook(socket: &Path, event: String, terminal: &mut dyn Terminal) {
    let started = Instant::now();
    let input = terminal
        .piped()
        .and_then(|piped| read_piped(piped).ok().flatten())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null);
    let left = || HOOK_WITHIN.checked_sub(started.elapsed()).filter(|d| !d.is_zero());
    let Ok(mut stream) = UnixStream::connect(socket) else { return };
    let request = CliRequest::MemoryHook { event, input };
    let Some(within) = left() else { return };
    if stream.set_write_timeout(Some(within)).is_err()
        || writeln!(stream, "{}", serde_json::to_string(&request).unwrap_or_default()).is_err()
    {
        return;
    }
    let mut reader = BufReader::new(&stream);
    let mut answer = None;
    loop {
        let Some(within) = left() else { return };
        // Fails once the app closed its side (macOS); the read then ends at once.
        let _ = stream.set_read_timeout(Some(within));
        let mut line = String::new();
        if !matches!(reader.read_line(&mut line), Ok(n) if n > 0) {
            return;
        }
        match serde_json::from_str::<CliFrame>(&line) {
            Ok(CliFrame::Json { value }) => answer = Some(value),
            Ok(CliFrame::Done { .. }) => break,
            _ => {}
        }
    }
    if let Some(answer) = answer {
        terminal.out(&answer.to_string());
    }
}

/// Piped text, at most 1 MiB; empty text is none.
fn read_piped(piped: &mut dyn Read) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    piped
        .take(CLI_STDIN_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read the piped text: {e}"))?;
    if bytes.len() > CLI_STDIN_MAX_BYTES {
        return Err("The piped text is over 1 MiB: save it to a file and pass --file.".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "The piped text is not UTF-8: pass it with --file.".to_owned())?;
    Ok((!text.trim().is_empty()).then_some(text))
}

fn set_stdin(request: &mut CliRequest, text: Option<String>) {
    match request {
        CliRequest::Run(run) => run.stdin = text,
        CliRequest::Once(once) => once.stdin = text,
        _ => {}
    }
}

/// The app answers `hello` on the socket.
fn reachable(socket: &Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    if writeln!(stream, "{}", serde_json::json!({"cmd": "hello"})).is_err() {
        return false;
    }
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).is_ok()
        && matches!(serde_json::from_str(&line), Ok(CliFrame::Hello { ready: true, .. }))
}

fn wait_until_reachable(socket: &Path, within: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < within {
        if reachable(socket) {
            return true;
        }
        std::thread::sleep(START_POLL);
    }
    false
}

enum Ending {
    Exit(i32),
    /// Several runs would start: asked again with `yes` once the user agrees.
    Confirm(String),
}

/// Sends the request and prints what comes back, until `done`.
fn ask(socket: &Path, request: &CliRequest, terminal: &mut dyn Terminal) -> Ending {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        terminal.err("Eos cannot be reached.");
        return Ending::Exit(exit::UNREACHABLE);
    };
    let line = serde_json::to_string(request).unwrap_or_default();
    if writeln!(stream, "{line}").is_err() {
        terminal.err("Eos cannot be reached.");
        return Ending::Exit(exit::UNREACHABLE);
    }
    // The write side stays open while the command waits: closing it detaches.
    let mut confirm = None;
    for line in BufReader::new(&stream).lines() {
        let Ok(line) = line else { break };
        match serde_json::from_str::<CliFrame>(&line) {
            Ok(CliFrame::Out { text }) => terminal.out(&text),
            Ok(CliFrame::Err { text }) => terminal.err(&text),
            Ok(CliFrame::Json { value }) => terminal.out(&value.to_string()),
            Ok(CliFrame::Confirm { text }) => confirm = Some(text),
            Ok(CliFrame::Done { exit }) => {
                return match confirm {
                    Some(text) => Ending::Confirm(text),
                    None => Ending::Exit(exit),
                };
            }
            Ok(CliFrame::Hello { .. }) | Err(_) => {}
        }
    }
    terminal.err("Eos stopped answering.");
    Ending::Exit(exit::UNREACHABLE)
}
