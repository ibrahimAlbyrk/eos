//! Moves one transfer's bytes from a source endpoint to a destination endpoint:
//! scan the picked items, stage them at the destination, copy every file in
//! chunks, then commit them into place. Resumable by construction: every write
//! says the offset it expects and the destination reports what it already
//! holds, so a dropped link, a pause or a restart only costs the chunk in
//! flight.
//!
//! Pause and cancel drop the future; whether the staging stays is the
//! caller's call.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use eos_contracts::{
    ManifestItem, ManifestItemType, TransferCommitRequest, TransferCommitResult, TransferConflict, TransferDecision,
    TransferErrorCode, TransferId, TransferManifest, TransferPrepareRequest, TransferRoute,
};
use eos_core::net::transfer::{ByteRange, FileStamp, TransferEndpoint, WriteAt};
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_domain::transfer::{
    RateMeter, TransferError, base_name, chunk_length, conflicts_of, file_concurrency, join_path, parent_dir, root_of,
};
use indexmap::IndexMap;
use tokio::task::JoinSet;

/// How long the link may stay down before a run gives up (and can be resumed).
pub const DEFAULT_OUTAGE_MS: i64 = 120_000;

/// What a run tells its owner, in order: scanned, prepared, progress…,
/// copied, committing.
pub trait RunEvents: Send + Sync + 'static {
    fn scanned(&self, manifest: &TransferManifest);
    fn prepared(&self, conflicts: &[TransferConflict], done_bytes: u64);
    fn progress(&self, done_bytes: u64, rate: f64);
    /// Resolves once every conflict has a decision — at once when they were
    /// preset. Bytes keep flowing meanwhile; only the commit waits.
    fn decisions<'a>(&'a self, conflicts: &'a [TransferConflict]) -> BoxFuture<'a, IndexMap<String, TransferDecision>>;
    /// Every byte is staged; what is left is the commit (and any decision it waits on).
    fn copied(&self);
    fn committing(&self);
}

#[derive(Clone)]
pub struct RunDeps {
    pub source: Arc<dyn TransferEndpoint>,
    pub dest: Arc<dyn TransferEndpoint>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    /// The link's current path: chunk size and concurrency follow it.
    pub route: Arc<dyn Fn() -> Option<TransferRoute> + Send + Sync>,
    pub events: Arc<dyn RunEvents>,
    pub outage_ms: i64,
}

impl std::fmt::Debug for RunDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunDeps").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInput {
    pub id: String,
    pub sources: Vec<String>,
    pub dest_dir: String,
}

/// What the file workers of one run share.
struct Run {
    deps: RunDeps,
    input: RunInput,
    /// Picked item name → the folder it was picked in.
    source_dirs: HashMap<String, String>,
    /// The files that still have bytes to copy, with what is staged of each.
    queue: Vec<(ManifestItem, u64)>,
    next: AtomicUsize,
    done: AtomicI64,
    meter: Mutex<RateMeter>,
    /// Since when the link has been down, across every call of the run.
    down_since: Mutex<Option<i64>>,
}

fn size_of(file: &ManifestItem) -> u64 {
    u64::try_from(file.size).unwrap_or(0)
}

impl Run {
    fn rate(&self) -> f64 {
        self.meter.lock().unwrap_or_else(PoisonError::into_inner).rate(self.deps.clock.now_ms())
    }

    /// Runs `op` again while the other computer is out of reach, waiting
    /// longer each time, until the outage outlasts the window.
    async fn retry<T, F, Fut>(&self, op: F) -> Result<T, TransferError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, TransferError>>,
    {
        let mut attempt = 0u32;
        loop {
            match op().await {
                Ok(value) => {
                    *self.down_since.lock().unwrap_or_else(PoisonError::into_inner) = None;
                    return Ok(value);
                }
                Err(e) if !e.is_transient() => return Err(e),
                Err(e) => {
                    let now = self.deps.clock.now_ms();
                    let since = *self.down_since.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert(now);
                    if now - since > self.deps.outage_ms {
                        return Err(e);
                    }
                    self.deps.sleeper.sleep((500 * 2i64.pow(attempt.min(5))).min(10_000)).await;
                    attempt += 1;
                }
            }
        }
    }

    fn source_path(&self, rel: &str) -> String {
        join_path(self.source_dirs.get(root_of(rel)).map_or("/", String::as_str), rel)
    }

    async fn read_at(&self, file: &ManifestItem, path: &str, at: u64) -> Result<Bytes, TransferError> {
        let size = size_of(file);
        let length = chunk_length((self.deps.route)(), self.rate()).min(size - at);
        let expect = FileStamp { size, mtime_ms: file.mtime_ms.as_f64() };
        self.retry(|| self.deps.source.read(path, ByteRange { offset: at, length }, expect)).await
    }

    async fn copy_file(&self, file: &ManifestItem, staged: u64) -> Result<(), TransferError> {
        let path = self.source_path(&file.rel);
        let size = size_of(file);
        let mut offset = staged;
        let mut chunk = self.read_at(file, &path, offset).await?;
        loop {
            if chunk.is_empty() {
                let message = format!("{} got shorter while it was being copied", file.rel);
                return Err(TransferError::new(TransferErrorCode::SourceChanged, message));
            }
            let length = chunk.len() as u64;
            let end = offset + length;
            let at = WriteAt {
                id: self.input.id.clone(),
                dest_dir: self.input.dest_dir.clone(),
                rel: file.rel.clone(),
                offset,
            };
            // The next read runs while this chunk is written.
            let write = self.retry(|| self.deps.dest.write(&at, chunk.clone()));
            let ahead = async { if end < size { Some(self.read_at(file, &path, end).await) } else { None } };
            let (written, ahead) = tokio::join!(write, ahead);
            let wrote = written.is_ok();
            let landed = match written {
                Ok(landed) => {
                    let now = self.deps.clock.now_ms();
                    self.meter.lock().unwrap_or_else(PoisonError::into_inner).add(length, now);
                    landed
                }
                // A retried write that had landed, or a restart: carry on from what is there.
                Err(e) => match e.have {
                    Some(have) if e.is(TransferErrorCode::OffsetMismatch) && have <= size => have,
                    _ => return Err(e),
                },
            };
            let moved = landed as i64 - offset as i64;
            let done = self.done.fetch_add(moved, Ordering::SeqCst) + moved;
            offset = landed;
            if wrote {
                self.deps.events.progress(u64::try_from(done).unwrap_or(0), self.rate());
            }
            if offset >= size {
                return Ok(());
            }
            chunk = match ahead {
                Some(next) if offset == end => next?,
                _ => self.read_at(file, &path, offset).await?,
            };
        }
    }

    /// Copies files off the queue until it is empty.
    async fn work(self: Arc<Self>) -> Result<(), TransferError> {
        loop {
            let Some((file, staged)) = self.queue.get(self.next.fetch_add(1, Ordering::SeqCst)) else { return Ok(()) };
            self.copy_file(file, *staged).await?;
        }
    }
}

pub async fn run_transfer(deps: RunDeps, input: RunInput) -> Result<TransferCommitResult, TransferError> {
    let events = deps.events.clone();
    let setup = Run {
        deps,
        input,
        source_dirs: HashMap::new(),
        queue: Vec::new(),
        next: AtomicUsize::new(0),
        done: AtomicI64::new(0),
        meter: Mutex::new(RateMeter::new(0)),
        down_since: Mutex::new(None),
    };
    let (source, dest) = (setup.deps.source.clone(), setup.deps.dest.clone());
    let id = TransferId(setup.input.id.clone());

    let manifest = setup.retry(|| source.scan(&setup.input.sources)).await?;
    events.scanned(&manifest);
    let request =
        TransferPrepareRequest { id: id.clone(), dest_dir: setup.input.dest_dir.clone(), items: manifest.items };
    let prepared = setup.retry(|| dest.prepare(&request)).await?;
    let conflicts = conflicts_of(&manifest.roots, &prepared.existing);

    let mut done = 0u64;
    let mut queue = Vec::new();
    for file in request.items.into_iter().filter(|item| item.r#type == ManifestItemType::File && item.size > 0) {
        let size = size_of(&file);
        let staged = prepared.staged.get(&file.rel).map_or(0, |held| u64::try_from(*held).unwrap_or(0)).min(size);
        done += staged;
        if staged < size {
            queue.push((file, staged));
        }
    }
    events.prepared(&conflicts, done);

    let workers = file_concurrency((setup.deps.route)()).min(queue.len()).max(1);
    let run = Arc::new(Run {
        source_dirs: setup.input.sources.iter().map(|p| (base_name(p).to_owned(), parent_dir(p).to_owned())).collect(),
        queue,
        done: AtomicI64::new(done as i64),
        meter: Mutex::new(RateMeter::new(setup.deps.clock.now_ms())),
        ..setup
    });
    // One failing file stops its siblings too: dropping the set ends them.
    let mut copying = JoinSet::new();
    for _ in 0..workers {
        copying.spawn(run.clone().work());
    }
    while let Some(ended) = copying.join_next().await {
        ended.map_err(TransferError::failed)??;
    }

    events.copied();
    let decisions = if conflicts.is_empty() { IndexMap::new() } else { events.decisions(&conflicts).await };
    events.committing();
    let commit = TransferCommitRequest { id, dest_dir: run.input.dest_dir.clone(), decisions };
    run.retry(|| dest.commit(&commit)).await
}
