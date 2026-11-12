//! Fakes of the terminal ports: terminals the test types into and speaks
//! for, command runs it ends itself, transcripts it writes in memory.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_core::terminal::{
    ClaudeLaunchEnv, ClaudeProgram, ClaudeTranscripts, CommandEvents, CommandExit, Pty, PtyEvents, PtySpawn,
    RunningCommand, Screen, ShellCommands, Terminals, TranscriptFile,
};
use eos_core::{BoxFuture, Error};
use eos_domain::claude_transcript::TranscriptView;

/// A terminal without a shell: the test is the program in it.
pub struct FakePty {
    pub spec: PtySpawn,
    events: Mutex<Option<Box<dyn PtyEvents>>>,
    written: Mutex<Vec<String>>,
    sizes: Mutex<Vec<(u16, u16)>>,
    kills: AtomicUsize,
    foreground: Mutex<Option<String>>,
}

impl std::fmt::Debug for FakePty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakePty").field("spec", &self.spec).finish_non_exhaustive()
    }
}

impl FakePty {
    /// The program prints `text`.
    pub fn emit(&self, text: &str) {
        if let Some(events) = self.events.lock().expect("events").as_mut() {
            events.output(text);
        }
    }

    /// The shell ends.
    pub fn exit(&self, code: i32) {
        if let Some(mut events) = self.events.lock().expect("events").take() {
            events.exit(code);
        }
    }

    /// Every piece of input, in the order written.
    pub fn written(&self) -> Vec<String> {
        self.written.lock().expect("written").clone()
    }

    pub fn sizes(&self) -> Vec<(u16, u16)> {
        self.sizes.lock().expect("sizes").clone()
    }

    pub fn kills(&self) -> usize {
        self.kills.load(Ordering::SeqCst)
    }

    /// What [`Pty::foreground`] answers from now on.
    pub fn set_foreground(&self, name: Option<&str>) {
        *self.foreground.lock().expect("foreground") = name.map(str::to_owned);
    }
}

impl Pty for FakePty {
    fn write(&self, data: &[u8]) {
        self.written.lock().expect("written").push(String::from_utf8_lossy(data).into_owned());
    }
    fn resize(&self, cols: u16, rows: u16) {
        self.sizes.lock().expect("sizes").push((cols, rows));
    }
    fn kill(&self) {
        self.kills.fetch_add(1, Ordering::SeqCst);
    }
    fn foreground(&self) -> Option<String> {
        self.foreground.lock().expect("foreground").clone()
    }
}

/// A screen that keeps what it was fed: its snapshot is `<cols>x<rows>:` and
/// every write, joined.
#[derive(Debug)]
struct FakeScreen {
    size: (u16, u16),
    text: String,
}

impl Screen for FakeScreen {
    fn write(&mut self, text: &str) {
        self.text.push_str(text);
    }
    fn resize(&mut self, cols: u16, rows: u16) {
        self.size = (cols, rows);
    }
    fn snapshot(&self) -> String {
        format!("{}x{}:{}", self.size.0, self.size.1, self.text)
    }
}

/// Terminals that start nothing. Each spawn is kept for the test to drive.
#[derive(Debug, Default)]
pub struct FakeTerminals {
    ptys: Mutex<Vec<Arc<FakePty>>>,
}

impl FakeTerminals {
    pub fn new() -> Self {
        Self::default()
    }

    /// The terminals spawned so far, oldest first.
    pub fn ptys(&self) -> Vec<Arc<FakePty>> {
        self.ptys.lock().expect("ptys").clone()
    }

    pub fn last(&self) -> Arc<FakePty> {
        self.ptys().last().cloned().expect("a terminal was spawned")
    }
}

impl Terminals for FakeTerminals {
    fn spawn(&self, spec: PtySpawn, events: Box<dyn PtyEvents>) -> Result<Arc<dyn Pty>, Error> {
        let pty = Arc::new(FakePty {
            spec,
            events: Mutex::new(Some(events)),
            written: Mutex::default(),
            sizes: Mutex::default(),
            kills: AtomicUsize::new(0),
            foreground: Mutex::new(Some("zsh".to_owned())),
        });
        self.ptys.lock().expect("ptys").push(pty.clone());
        Ok(pty)
    }

    fn screen(&self, cols: u16, rows: u16) -> Box<dyn Screen> {
        Box::new(FakeScreen { size: (cols, rows), text: String::new() })
    }

    fn or_else(&self, a: &str, b: &str) -> String {
        format!("{a} || {b}")
    }

    fn tty_hooks(&self) -> bool {
        true
    }
}

/// Claude Code at a fixed word, or missing.
#[derive(Debug, Clone)]
pub struct FakeClaudeProgram(pub Option<String>);

impl ClaudeProgram for FakeClaudeProgram {
    fn locate(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(std::future::ready(self.0.clone()))
    }
}

/// A fixed environment for Claude panes (`None`: the process's own).
#[derive(Debug, Clone, Default)]
pub struct FakeClaudeEnv(pub Option<Vec<(String, String)>>);

impl ClaudeLaunchEnv for FakeClaudeEnv {
    fn env(&self) -> BoxFuture<'_, Option<Vec<(String, String)>>> {
        Box::pin(std::future::ready(self.0.clone()))
    }
}

/// One command the test stands in for.
pub struct FakeRun {
    pub cwd: String,
    pub command: String,
    pub timeout: Duration,
    events: Mutex<Option<Box<dyn CommandEvents>>>,
    kills: AtomicUsize,
}

impl std::fmt::Debug for FakeRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeRun").field("command", &self.command).finish_non_exhaustive()
    }
}

impl FakeRun {
    pub fn emit(&self, text: &str) {
        if let Some(events) = self.events.lock().expect("events").as_mut() {
            events.output(text);
        }
    }

    pub fn exit(&self, code: Option<i32>, signal: Option<&str>, timed_out: bool) {
        if let Some(mut events) = self.events.lock().expect("events").take() {
            events.exit(CommandExit { code, signal: signal.map(str::to_owned), timed_out });
        }
    }

    pub fn fail(&self, reason: &str) {
        if let Some(mut events) = self.events.lock().expect("events").take() {
            events.failed(reason.to_owned());
        }
    }

    pub fn kills(&self) -> usize {
        self.kills.load(Ordering::SeqCst)
    }
}

impl RunningCommand for FakeRun {
    fn kill(&self) {
        self.kills.fetch_add(1, Ordering::SeqCst);
    }
}

/// Command lines that run nothing; every folder but the listed missing ones exists.
#[derive(Debug, Default)]
pub struct FakeShellCommands {
    runs: Mutex<Vec<Arc<FakeRun>>>,
    pub missing_folders: Mutex<Vec<String>>,
}

impl FakeShellCommands {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn runs(&self) -> Vec<Arc<FakeRun>> {
        self.runs.lock().expect("runs").clone()
    }

    pub fn last(&self) -> Arc<FakeRun> {
        self.runs().last().cloned().expect("a command was run")
    }
}

impl ShellCommands for FakeShellCommands {
    fn folder(&self, path: &str) -> Option<String> {
        (!self.missing_folders.lock().expect("folders").iter().any(|m| m == path)).then(|| path.to_owned())
    }

    fn run(
        &self,
        cwd: &str,
        command: &str,
        timeout: Duration,
        events: Box<dyn CommandEvents>,
    ) -> Arc<dyn RunningCommand> {
        let run = Arc::new(FakeRun {
            cwd: cwd.to_owned(),
            command: command.to_owned(),
            timeout,
            events: Mutex::new(Some(events)),
            kills: AtomicUsize::new(0),
        });
        self.runs.lock().expect("runs").push(run.clone());
        run
    }
}

type Transcript = Arc<Mutex<(Option<TranscriptView>, u64)>>;

/// Transcripts kept in memory, by `(cwd, session id)`.
#[derive(Debug, Default)]
pub struct FakeTranscripts {
    files: Mutex<HashMap<(String, String), Transcript>>,
}

impl FakeTranscripts {
    pub fn new() -> Self {
        Self::default()
    }

    fn file(&self, cwd: &str, session_id: &str) -> Transcript {
        self.files.lock().expect("files").entry((cwd.to_owned(), session_id.to_owned())).or_default().clone()
    }

    /// Claude wrote: the transcript now reads as `view`, and its stamp moves.
    pub fn set(&self, cwd: &str, session_id: &str, view: TranscriptView) {
        let file = self.file(cwd, session_id);
        let mut state = file.lock().expect("file");
        state.0 = Some(view);
        state.1 += 1;
    }
}

struct FakeTranscriptFile(Transcript);

impl TranscriptFile for FakeTranscriptFile {
    fn read(&mut self) -> Option<TranscriptView> {
        self.0.lock().expect("file").0.clone()
    }
    fn stamp(&self) -> Option<(u64, i64)> {
        let state = self.0.lock().expect("file");
        state.0.as_ref().map(|_| (state.1, 0))
    }
}

impl ClaudeTranscripts for FakeTranscripts {
    fn open(&self, cwd: &str, session_id: &str) -> Box<dyn TranscriptFile> {
        Box::new(FakeTranscriptFile(self.file(cwd, session_id)))
    }
}
