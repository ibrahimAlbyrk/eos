//! The terminal's gateway (07 §4.4): `eos` talks to the running app over `cli.sock` in the
//! shell's data folder. The socket is the user's alone (mode 0600), and every connection's
//! peer must be the user who runs the app. One request per connection, read within 10 s and
//! at most 2 MiB; at most 8 connections at once. Each command becomes the dashboard's own core
//! calls ([`commands`]), so a dev run's guard refuses here what it refuses there. The command
//! keeps its side open while it waits: closing it detaches, and the run goes on.
//!
//! Logged: the command, routine and run ids, how it ended, how long it took. Never the
//! arguments, notes or piped text.

mod commands;
#[cfg(test)]
mod tests;
mod wait;

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use eos_contracts::cli::{CLI_REQUEST_MAX_BYTES, CliFrame, CliRequest, exit};
use eos_contracts::validate::check;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

use crate::core::Core;
use commands::Ctx;

/// The socket's name in the shell's data folder.
pub const SOCKET: &str = "cli.sock";
const MAX_CONNECTIONS: usize = 8;
const REQUEST_WITHIN: Duration = Duration::from_secs(10);

#[derive(Debug, Default)]
struct Counts {
    served: AtomicU64,
    /// Connections of another user, closed without an answer.
    other_user: AtomicU64,
    /// Connections past the limit, or that sent no request in time.
    dropped: AtomicU64,
}

/// The gateway while it listens. Dropping it stops it and removes the socket.
#[derive(Debug)]
pub struct CliGateway {
    socket: PathBuf,
    task: JoinHandle<()>,
    counts: Arc<Counts>,
}

/// What the gateway is handed.
pub struct CliParts {
    pub core: Arc<dyn Core>,
    /// The shell's data folder, where the socket goes.
    pub data_dir: PathBuf,
    /// `eos` or `eos-dev`: how the links it prints begin.
    pub scheme: &'static str,
    pub version: String,
}

impl std::fmt::Debug for CliParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CliParts")
            .field("data_dir", &self.data_dir)
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

impl CliGateway {
    /// Listens on `<data_dir>/cli.sock`; a socket left by an app that crashed is replaced.
    pub fn start(parts: CliParts, rt: &tokio::runtime::Handle) -> std::io::Result<Self> {
        let socket = parts.data_dir.join(SOCKET);
        std::fs::create_dir_all(&parts.data_dir)?;
        match std::fs::remove_file(&socket) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let listener = {
            let _entered = rt.enter();
            UnixListener::bind(&socket)?
        };
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        // The socket was made by this process: its owner is the user the app runs as.
        let uid = std::fs::metadata(&socket)?.uid();
        let counts = Arc::new(Counts::default());
        let shared = Arc::new(Shared { parts, uid, counts: counts.clone(), slots: Semaphore::new(MAX_CONNECTIONS) });
        let task = rt.spawn(accept(listener, shared));
        Ok(CliGateway { socket, task, counts })
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Counts only, for `--status`.
    pub fn status(&self) -> Value {
        json!({
            "served": self.counts.served.load(Ordering::Relaxed),
            "otherUser": self.counts.other_user.load(Ordering::Relaxed),
            "dropped": self.counts.dropped.load(Ordering::Relaxed),
        })
    }
}

impl Drop for CliGateway {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}

struct Shared {
    parts: CliParts,
    uid: u32,
    counts: Arc<Counts>,
    slots: Semaphore,
}

async fn accept(listener: UnixListener, shared: Arc<Shared>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        if stream.peer_cred().map(|c| c.uid()).ok() != Some(shared.uid) {
            shared.counts.other_user.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(target: "eos::cli", "a connection of another user was closed");
            continue;
        }
        let shared = shared.clone();
        tokio::spawn(async move {
            let Ok(_slot) = shared.slots.try_acquire() else {
                shared.counts.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            };
            serve(stream, &shared).await;
        });
    }
}

/// One request line, at most the limit; `None` past it, at the end of the stream or late.
async fn request_line(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Option<Vec<u8>> {
    let mut line = Vec::new();
    let mut bounded = (&mut *reader).take(CLI_REQUEST_MAX_BYTES as u64 + 1);
    match tokio::time::timeout(REQUEST_WITHIN, bounded.read_until(b'\n', &mut line)).await {
        Ok(Ok(n)) if n > 0 && line.len() <= CLI_REQUEST_MAX_BYTES + 1 && line.ends_with(b"\n") => Some(line),
        _ => None,
    }
}

fn name_of(request: &CliRequest) -> &'static str {
    match request {
        CliRequest::Hello => "hello",
        CliRequest::Routines { .. } => "routines",
        CliRequest::Run(_) => "run",
        CliRequest::Once(_) => "once",
        CliRequest::Halt => "halt",
        CliRequest::Resume => "resume",
        CliRequest::MemoryHook { .. } => "memory-hook",
    }
}

async fn serve(stream: UnixStream, shared: &Shared) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let Some(line) = request_line(&mut reader).await else {
        shared.counts.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    };
    shared.counts.served.fetch_add(1, Ordering::Relaxed);
    let (out, mut frames) = mpsc::unbounded_channel::<CliFrame>();
    let writer = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            let mut text = serde_json::to_string(&frame).unwrap_or_default();
            text.push('\n');
            if write.write_all(text.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let parts = &shared.parts;
    let ctx = Ctx { core: parts.core.clone(), scheme: parts.scheme, version: parts.version.clone(), out };
    let started = Instant::now();
    let (name, code) = match serde_json::from_slice::<CliRequest>(&line) {
        Ok(request) => match check(&request) {
            Ok(()) => {
                let name = name_of(&request);
                // The command going away (Ctrl-C) ends what it waited for; the run goes on.
                let code = tokio::select! {
                    code = commands::handle(&ctx, request) => code,
                    _ = closed(&mut reader) => exit::DETACHED,
                };
                (name, code)
            }
            Err(problem) => {
                ctx.err(problem.message());
                ("invalid", exit::REFUSED)
            }
        },
        Err(_) => {
            ctx.err("Eos does not know this command: update the `eos` command.");
            ("unknown", exit::REFUSED)
        }
    };
    ctx.send(CliFrame::Done { exit: code });
    drop(ctx);
    let _ = writer.await;
    tracing::info!(target: "eos::cli", command = name, exit = code, ms = started.elapsed().as_millis() as u64, "served");
}

/// Ends when the command closes its side.
async fn closed(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) {
    let mut buf = [0u8; 64];
    while matches!(reader.read(&mut buf).await, Ok(n) if n > 0) {}
}
