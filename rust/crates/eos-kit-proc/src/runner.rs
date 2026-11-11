use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::command::{Command, Overflow};
use crate::error::Error;

/// Bytes read from a pipe at a time.
const CHUNK: usize = 16 * 1024;
/// Chunks waiting for the consumer. When full the readers wait, the pipe fills
/// and the child blocks on its write: nothing is dropped and nothing grows
/// (at most `EVENT_QUEUE × CHUNK` bytes sit here per child).
const EVENT_QUEUE: usize = 32;
/// How long output is still collected after the child itself is gone. A
/// process it left behind can hold the pipe open forever.
const PIPE_GRACE: Duration = Duration::from_millis(500);
/// After a kill, the tree is signalled again until nothing is left, at most
/// this many times, this far apart.
const SWEEPS: usize = 5;
const SWEEP_PAUSE: Duration = Duration::from_millis(2);

/// How this system makes and ends process trees; the platform seam provides both.
#[derive(Clone)]
pub struct ProcessTrees {
    isolate: Arc<dyn Fn(&mut std::process::Command) + Send + Sync>,
    kill: Arc<dyn Fn(u32) -> bool + Send + Sync>,
}

impl ProcessTrees {
    /// `isolate` makes the command's child lead its own tree; `kill` ends the
    /// tree the process with that id leads and says whether anything was
    /// there to end.
    pub fn new(
        isolate: impl Fn(&mut std::process::Command) + Send + Sync + 'static,
        kill: impl Fn(u32) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self { isolate: Arc::new(isolate), kill: Arc::new(kill) }
    }
}

impl std::fmt::Debug for ProcessTrees {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessTrees").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct Runner {
    trees: ProcessTrees,
}

/// How a child ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exit {
    /// `None` when a signal ended it (a timeout, a kill).
    pub code: Option<i32>,
    /// The deadline passed and the tree was ended.
    pub timed_out: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    /// Always the last event.
    Exit(Exit),
}

/// The result of [`Runner::run`]. A timeout is not an error: what was printed
/// until then is here, with `timed_out` set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    pub pid: u32,
    /// `None` when a signal ended it.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// More was printed than the cap kept.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl Output {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// A running command. Dropping it ends the command's whole tree.
#[derive(Debug)]
pub struct Child {
    pid: u32,
    events: mpsc::Receiver<Event>,
    trees: ProcessTrees,
    killed: Arc<AtomicBool>,
}

impl Child {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The next piece of output, then [`Event::Exit`], then `None`. Output of
    /// one stream arrives in order.
    pub async fn next(&mut self) -> Option<Event> {
        self.events.recv().await
    }

    /// Ends the command and everything it started. After the command itself
    /// has exited this still ends what it left running in its tree.
    pub fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        (self.trees.kill)(self.pid);
    }
}

/// Ends the tree unless the child was seen to exit: covers the watcher being
/// dropped with its runtime.
struct TreeGuard {
    pid: u32,
    trees: ProcessTrees,
    armed: bool,
}

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if self.armed {
            (self.trees.kill)(self.pid);
        }
    }
}

async fn pump(mut pipe: impl AsyncRead + Unpin, events: mpsc::Sender<Event>, wrap: fn(Vec<u8>) -> Event) {
    let mut buf = vec![0u8; CHUNK];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if events.send(wrap(buf[..n].to_vec())).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn finished(handle: Option<JoinHandle<()>>) {
    if let Some(handle) = handle {
        let _ = handle.await;
    }
}

/// A kill signals the processes that are in the tree at that instant; one
/// being forked right then is missed. Once the child itself is reaped it can
/// start nothing more, so signalling until the tree is empty catches the rest.
async fn sweep(trees: &ProcessTrees, pid: u32) {
    for _ in 0..SWEEPS {
        if !(trees.kill)(pid) {
            break;
        }
        tokio::time::sleep(SWEEP_PAUSE).await;
    }
}

async fn watch(
    mut child: tokio::process::Child,
    pid: u32,
    events: mpsc::Sender<Event>,
    stdin: Option<Vec<u8>>,
    timeout: Option<Duration>,
    trees: ProcessTrees,
    killed: Arc<AtomicBool>,
) {
    let mut guard = TreeGuard { pid, trees, armed: true };
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        tokio::spawn(async move {
            // A child that exits without reading gives EPIPE; its exit tells the story.
            let _ = pipe.write_all(&input).await;
            let _ = pipe.shutdown().await;
        });
    }
    let stdout = child.stdout.take().map(|pipe| tokio::spawn(pump(pipe, events.clone(), Event::Stdout)));
    let stderr = child.stderr.take().map(|pipe| tokio::spawn(pump(pipe, events.clone(), Event::Stderr)));
    let aborts: Vec<_> = [&stdout, &stderr].into_iter().flatten().map(JoinHandle::abort_handle).collect();

    let deadline = async {
        match timeout {
            Some(timeout) => tokio::time::sleep(timeout).await,
            None => std::future::pending().await,
        }
    };
    let (status, timed_out) = tokio::select! {
        status = child.wait() => (status, false),
        () = deadline => {
            killed.store(true, Ordering::SeqCst);
            (guard.trees.kill)(pid);
            (child.wait().await, true)
        }
        // Nobody listens any more.
        () = events.closed() => {
            killed.store(true, Ordering::SeqCst);
            (guard.trees.kill)(pid);
            (child.wait().await, false)
        }
    };
    // Reaped: the guard has nothing left to protect.
    guard.armed = false;
    if killed.load(Ordering::SeqCst) {
        sweep(&guard.trees, pid).await;
    }

    let drained = async {
        finished(stdout).await;
        finished(stderr).await;
    };
    if tokio::time::timeout(PIPE_GRACE, drained).await.is_err() {
        for abort in aborts {
            abort.abort();
        }
    }
    let code = status.ok().and_then(|s| s.code());
    let _ = events.send(Event::Exit(Exit { code, timed_out })).await;
}

fn keep(kept: &mut Vec<u8>, truncated: &mut bool, chunk: &[u8], max: usize) {
    let room = max.saturating_sub(kept.len());
    kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
    *truncated |= chunk.len() > room;
}

impl Runner {
    pub fn new(trees: ProcessTrees) -> Self {
        Self { trees }
    }

    /// Starts the command and hands back its output as it arrives. The
    /// command's deadline applies; its output cap does not (the consumer
    /// decides what to keep).
    pub fn spawn(&self, command: Command) -> Result<Child, Error> {
        let mut std_command = std::process::Command::new(&command.program);
        std_command.args(&command.args).env_clear().envs(command.env.resolve(std::env::vars_os()));
        if let Some(cwd) = &command.cwd {
            std_command.current_dir(cwd);
        }
        (self.trees.isolate)(&mut std_command);

        let mut tokio_command = tokio::process::Command::from(std_command);
        tokio_command
            .stdin(if command.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let spawn_error = |source| Error::Spawn { program: command.program.to_string_lossy().into_owned(), source };
        let child = tokio_command.spawn().map_err(spawn_error)?;
        let pid = child.id().ok_or_else(|| spawn_error(std::io::Error::other("the child has no process id")))?;

        let (tx, rx) = mpsc::channel(EVENT_QUEUE);
        let killed = Arc::new(AtomicBool::new(false));
        tokio::spawn(watch(child, pid, tx, command.stdin, command.timeout, self.trees.clone(), killed.clone()));
        Ok(Child { pid, events: rx, trees: self.trees.clone(), killed })
    }

    /// Runs the command to its end, or to its deadline. Dropping the returned
    /// future ends the command's tree.
    pub async fn run(&self, command: Command) -> Result<Output, Error> {
        let (max, overflow) = (command.max_output, command.overflow);
        let mut child = self.spawn(command)?;
        let mut out = Output { pid: child.pid(), ..Output::default() };
        while let Some(event) = child.next().await {
            match event {
                Event::Stdout(chunk) => keep(&mut out.stdout, &mut out.stdout_truncated, &chunk, max),
                Event::Stderr(chunk) => keep(&mut out.stderr, &mut out.stderr_truncated, &chunk, max),
                Event::Exit(exit) => {
                    out.exit_code = exit.code;
                    out.timed_out = exit.timed_out;
                    return Ok(out);
                }
            }
            if overflow == Overflow::Fail && (out.stdout_truncated || out.stderr_truncated) {
                // Dropping `child` ends the tree.
                return Err(Error::OutputTooLarge { limit: max });
            }
        }
        Err(Error::Lost)
    }
}
