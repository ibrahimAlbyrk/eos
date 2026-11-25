//! Sources on this computer (02 §4.5 rows "folder" and "git"): a folder's
//! direct files and a repository's branch.
//!
//! Each scheduler pass keeps one `signal_sources` row per folder and per
//! branch an active routine held here reads, holds a watch on each while it
//! is read and stops the rest, as the poll driver does for capability
//! sources. A row is read when its watcher reported a change
//! (`fs:change`, `git:change`), when a file it saw is due to have settled,
//! and every [`FOLDER_LISTING_MS`] besides, which also finds what changed
//! while Eos was closed. What it found goes through ingest and the router
//! like any page. Neither source reaches outside the computer, so both
//! work in a development run.
//!
//! A row that cannot be read is `needs-attention` with a kind the routine
//! page shows: `missing`, `no-access`, `inside-data`, `too-many` or
//! `too-many-folders`; it is tried again at the next listing or change.

mod folder;
mod git;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{RoutineState, Trigger};
use eos_core::git::{GitInfo, GitWatcher};
use eos_core::os::{FileSystem, FileWatcher, WatchLease};
use eos_core::routine::RoutineTriggers;
use eos_core::signals::{PollPage, SignalDraft};
use eos_core::store::{Store, StoredSignalSource};
use eos_core::{Clock, Error, Ids};
use eos_domain::signals::when::inside_folder;
use serde_json::Value;

use crate::router::{Router, error_kind};
use crate::sources::{SourceSpec, source_in};

/// A file counts once its size and modified time held this long.
pub const FOLDER_SETTLE_MS: i64 = 2_000;
/// Every local source is read at least this often.
pub const FOLDER_LISTING_MS: i64 = 15 * 60_000;
pub use eos_domain::signals::limits::{FOLDER_ENTRIES_MAX, FOLDERS_MAX};
/// The most paths a branch's signal names.
pub const GIT_PATHS_MAX: usize = 300;

/// The kinds of the rows this module reads here.
pub(crate) const FOLDER: &str = "folder";
/// The kind of a file's signal once it is gone from its folder.
pub(crate) const REMOVED: &str = "removed";
pub(crate) const GIT: &str = "git";

/// The scope hash of the folder at `path`.
pub(crate) fn folder_scope(path: &str) -> String {
    format!("{FOLDER}:{path}")
}

/// The scope hash of `branch` in the repository at `repo`.
pub(crate) fn git_scope(repo: &str, branch: &str) -> String {
    format!("{GIT}:{repo}:{branch}")
}

/// One local source a routine reads.
struct Wanted {
    kind: &'static str,
    scope_json: String,
    /// The folder or the repository.
    path: PathBuf,
}

/// What reading a row found: the page to keep, or why it could not be read.
pub(crate) type Read = Result<Option<PollPage>, &'static str>;

pub(crate) struct Local {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) router: Arc<Router>,
    pub(crate) files: Arc<dyn FileWatcher>,
    pub(crate) git: Arc<dyn GitWatcher>,
    pub(crate) git_info: Arc<dyn GitInfo>,
    pub(crate) disk: Arc<dyn FileSystem>,
    /// Eos's own data folder, which no routine may watch.
    pub(crate) data_dir: PathBuf,
    /// The watch held on each row's folder or repository, by scope hash.
    pub(crate) leases: Mutex<HashMap<String, (PathBuf, WatchLease)>>,
    /// The watched folders and repositories that reported a change.
    pub(crate) changed: Mutex<HashSet<PathBuf>>,
    /// Per folder row, the files that changed and have not settled: their
    /// size and modified time, and since when they held.
    pub(crate) settling: Mutex<HashMap<String, BTreeMap<String, Settling>>>,
}

/// A file seen changed, waiting to hold still.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settling {
    pub(crate) stat: (u64, i64),
    pub(crate) since: i64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Local {
    /// A watcher reported a change in `dir`: answers whether a source here
    /// reads it, which is then read on the next pass.
    pub(crate) fn changed(&self, dir: &Path) -> bool {
        let watched = locked(&self.leases).values().any(|(path, _)| path == dir);
        if watched {
            locked(&self.changed).insert(dir.to_owned());
        }
        watched
    }

    /// Gives back every watch.
    pub(crate) fn release(&self) {
        locked(&self.leases).clear();
    }

    /// Keeps the rows `held` read, watches them, and reads each that is
    /// due; answers when the next is due. A row that cannot be read or
    /// settled is logged and tried again later, while the others are read.
    pub(crate) async fn pass(&self, held: &[Arc<RoutineTriggers>]) -> Result<Option<i64>, Error> {
        let rows = self.ensure(held).await?;
        self.watch(&rows);
        let changed = std::mem::take(&mut *locked(&self.changed));
        let mut next: Option<i64> = None;
        for row in rows {
            let now = self.clock.now_ms();
            let path = PathBuf::from(&row.path);
            let settle_at = self.settle_at(&row.row.id);
            let due = changed.contains(&path)
                || row.row.next_poll_at.is_none_or(|at| at <= now)
                || settle_at.is_some_and(|at| at <= now);
            let row = if due {
                match self.read(row).await {
                    Ok(row) => row,
                    Err((source_id, error)) => {
                        tracing::warn!(%source_id, error = error_kind(&error), "a local source could not be read");
                        continue;
                    }
                }
            } else {
                row.row
            };
            let at = [row.next_poll_at, self.settle_at(&row.id)].into_iter().flatten().min();
            next = [next, at].into_iter().flatten().min();
        }
        Ok(next)
    }

    /// When the first file of the row that waits to settle has.
    fn settle_at(&self, source_id: &str) -> Option<i64> {
        let settling = locked(&self.settling);
        settling.get(source_id)?.values().map(|seen| seen.since + FOLDER_SETTLE_MS).min()
    }

    /// Reads one row, keeps what it found and settles the row.
    async fn read(&self, wanted: Row) -> Result<StoredSignalSource, (String, Error)> {
        let Row { row, path, refused } = wanted;
        let found: Read = match refused {
            Some(kind) => Err(kind),
            None if row.kind == FOLDER => self.read_folder(&row, Path::new(&path)).await,
            None => self.read_git(&row, Path::new(&path)).await,
        };
        let source_id = row.id.clone();
        let error = match found {
            Ok(Some(page)) => match self.router.ingest(&source_id, page).await {
                Ok(_) => None,
                Err(error) => return Err((source_id, error)),
            },
            Ok(None) => None,
            Err(kind) => Some(kind),
        };
        let now = self.clock.now_ms();
        let job = move |tx: &dyn eos_core::store::Tx, _: &mut eos_core::store::Outbox| {
            let Some(mut row) = tx.signal_sources().find(&source_id)? else { return Ok(None) };
            let before = (row.state.clone(), row.error_kind.clone());
            row.state = if error.is_some() { "needs-attention" } else { "active" }.into();
            row.error_kind = error.map(str::to_owned);
            row.failures = if error.is_some() { row.failures + 1 } else { 0 };
            row.last_poll_at = Some(now);
            row.next_poll_at = Some(now + FOLDER_LISTING_MS);
            row.updated_at = now;
            tx.signal_sources().update(&row)?;
            Ok(Some((before, row)))
        };
        let source_id = row.id.clone();
        match self.store.write(job).await {
            Ok(Some(((state, error_kind), row))) => {
                if (state, error_kind) != (row.state.clone(), row.error_kind.clone()) {
                    tracing::info!(source_id = %row.id, kind = %row.kind, state = %row.state, error_kind = row.error_kind.as_deref(), failures = row.failures, "a source's state changed");
                }
                Ok(row)
            }
            Ok(None) => Ok(row),
            Err(error) => Err((source_id, error)),
        }
    }

    /// Takes a watch on each row read and gives back the others'.
    fn watch(&self, rows: &[Row]) {
        let mut leases = locked(&self.leases);
        let watching: HashSet<&str> =
            rows.iter().filter(|row| row.refused.is_none()).map(|row| row.row.scope_hash.as_str()).collect();
        leases.retain(|scope, _| watching.contains(scope.as_str()));
        for row in rows.iter().filter(|row| row.refused.is_none()) {
            if leases.contains_key(&row.row.scope_hash) {
                continue;
            }
            let path = PathBuf::from(&row.path);
            let lease = if row.row.kind == FOLDER { self.files.watch(&path) } else { self.git.watch(&path) };
            leases.insert(row.row.scope_hash.clone(), (path, lease));
        }
        let rows: HashSet<&str> = rows.iter().map(|row| row.row.id.as_str()).collect();
        locked(&self.settling).retain(|source_id, _| rows.contains(source_id.as_str()));
    }

    /// Keeps one row per folder and branch the active routines `held` read,
    /// resumes a stopped one from its cursor and stops the rows none reads.
    /// Answers the rows read, each with its folder or repository and, past
    /// [`FOLDERS_MAX`] folders or inside the data folder, why it is not.
    async fn ensure(&self, held: &[Arc<RoutineTriggers>]) -> Result<Vec<Row>, Error> {
        let mut wanted: BTreeMap<String, Wanted> = BTreeMap::new();
        for routine in held.iter().filter(|routine| routine.state == RoutineState::Active) {
            for trigger in &routine.when.on {
                let (scope_hash, found) = match trigger {
                    Trigger::Folder { folder, .. } => (
                        folder_scope(&folder.path),
                        Wanted {
                            kind: FOLDER,
                            scope_json: serde_json::json!({ "path": folder.path }).to_string(),
                            path: PathBuf::from(&folder.path),
                        },
                    ),
                    Trigger::Git { git, .. } => (
                        git_scope(&git.repo, &git.branch),
                        Wanted {
                            kind: GIT,
                            scope_json: serde_json::json!({ "repo": git.repo, "branch": git.branch }).to_string(),
                            path: PathBuf::from(&git.repo),
                        },
                    ),
                    _ => continue,
                };
                wanted.insert(scope_hash, found);
            }
        }
        let (ids, now) = (self.ids.clone(), self.clock.now_ms());
        let rows = self
            .store
            .write(move |tx, _| {
                let mut rows = Vec::new();
                for (scope_hash, want) in &wanted {
                    let spec = SourceSpec {
                        kind: want.kind,
                        source: None,
                        scope_json: want.scope_json.clone(),
                        scope_hash: scope_hash.clone(),
                        interval_ms: FOLDER_LISTING_MS,
                    };
                    let (mut row, _) = source_in(tx, ids.as_ref(), spec, now)?;
                    if row.state == "stopped" {
                        tracing::info!(source_id = %row.id, state = "active", "a source resumes from its cursor");
                        row = StoredSignalSource {
                            state: "active".into(),
                            stopped_at: None,
                            next_poll_at: Some(now),
                            updated_at: now,
                            ..row
                        };
                        tx.signal_sources().update(&row)?;
                    }
                    rows.push((row, want.path.clone()));
                }
                for row in tx.signal_sources().all()? {
                    let local = row.kind == FOLDER || row.kind == GIT;
                    if local && row.state != "stopped" && !wanted.contains_key(&row.scope_hash) {
                        tracing::info!(source_id = %row.id, state = "stopped", "no routine reads a source");
                        let row = StoredSignalSource {
                            state: "stopped".into(),
                            stopped_at: Some(now),
                            next_poll_at: None,
                            updated_at: now,
                            ..row
                        };
                        tx.signal_sources().update(&row)?;
                    }
                }
                Ok(rows)
            })
            .await?;
        let data_dir = self.real(&self.data_dir).await;
        let mut folders = 0;
        let mut read = Vec::with_capacity(rows.len());
        for (row, path) in rows {
            let refused = if inside_folder(&self.real(&path).await, &data_dir) {
                Some("inside-data")
            } else if row.kind == FOLDER {
                folders += 1;
                (folders > FOLDERS_MAX).then_some("too-many-folders")
            } else {
                None
            };
            read.push(Row { path: path.to_string_lossy().into_owned(), row, refused });
        }
        Ok(read)
    }

    /// `path` with its links resolved, so a link into the data folder counts
    /// as inside it; as written when it cannot be resolved.
    async fn real(&self, path: &Path) -> PathBuf {
        self.disk.canonical(path).await.unwrap_or_else(|_| path.to_owned())
    }
}

/// A row read here, with its folder or repository.
struct Row {
    row: StoredSignalSource,
    path: String,
    /// Why it is not read, when it may not be.
    refused: Option<&'static str>,
}

/// The cursor a row keeps, read back.
fn cursor_of(row: &StoredSignalSource) -> Option<Value> {
    row.cursor_json.as_deref().and_then(|json| serde_json::from_str(json).ok())
}

/// One read's page: what changed, and the cursor that follows it.
fn page(items: Vec<SignalDraft>, cursor: Value) -> PollPage {
    PollPage { items, cursor, more: false, baseline: false, poll_after_ms: None, retry_at: None }
}
