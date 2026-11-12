//! A worker's folder as git sees it (`manager/routes/workers.ts`: diff,
//! changes, push, pull, Try, conflicts, open; `orchestrators.ts`: integrate).
//!
//! The reads answer 200 with an empty result for a worker that is gone or
//! has no folder yet, so a poll racing a removal never shows an error. What
//! changes the user's checkout needs the user's own dashboard.
//!
//! | Module | Routes |
//! |---|---|
//! | `changes` | `diff`, `changes`, `changes/file`, `changes/discard`, `open` |
//! | `sync` | `push-state`, `push`, `pull` |
//! | `conflicts` | `conflicts`, `conflicts/file`, `conflicts/resolve` |
//! | `tries` | `try/preview`, `try/state`, `try`, `try/keep`, `try/discard`; applying on report |
//! | `integrate` | `POST /orchestrators/{id}/integrate` |

mod changes;
mod conflicts;
mod integrate;
mod sync;
mod tries;

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::WorkerEventType;
use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_core::Error;
use eos_core::git::{
    BranchIntegration, BranchMerge, BranchPush, ConflictResolution, GitDiffs, GitInfo, RemoteSync, WorkingTreeRestore,
};
use eos_core::os::DesktopFiles;
use eos_domain::Worker;
use eos_runtime::http::ApiError;
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

use crate::AgentsModule;

pub(crate) use tries::auto_apply;

/// What the routes over a worker's folder reach.
#[derive(Clone)]
pub struct WorkerGit {
    pub info: Arc<dyn GitInfo>,
    pub diffs: Arc<dyn GitDiffs>,
    pub push: Arc<dyn BranchPush>,
    pub remotes: Arc<dyn RemoteSync>,
    pub conflicts: Arc<dyn ConflictResolution>,
    pub restore: Arc<dyn WorkingTreeRestore>,
    /// Try: the worker's work shown in the user's checkout.
    pub tries: Arc<dyn BranchIntegration>,
    /// An orchestrator merging its workers' work.
    pub merge: Arc<dyn BranchMerge>,
    /// "Open in": the folder in the file manager or an editor.
    pub desktop: Arc<dyn DesktopFiles>,
}

impl std::fmt::Debug for WorkerGit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerGit").finish_non_exhaustive()
    }
}

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    let mut all = changes::all(m);
    all.extend(sync::all(m));
    all.extend(conflicts::all(m));
    all.extend(tries::all(m));
    all.push(integrate::integrate(m.clone()));
    all
}

fn not_found() -> ApiError {
    ApiError::NotFound("worker not found".into())
}

fn no_folder() -> ApiError {
    ApiError::Validation("worker has no working directory".into())
}

fn not_repo_relative() -> ApiError {
    ApiError::Validation("path must be repo-relative".into())
}

impl AgentsModule {
    pub(crate) fn git(&self) -> &WorkerGit {
        &self.git
    }

    /// The worker, or 404.
    async fn existing(&self, id: &str) -> Result<Worker, ApiError> {
        self.worker(id).await?.ok_or_else(not_found)
    }

    /// The fork point a worktree worker's changes are shown against, so the
    /// commits it made after forking still count. The sha written when the
    /// worktree was made; for older rows, the merge base with the source as it
    /// is now. `None` compares with HEAD.
    async fn diff_base(&self, worker: &Worker) -> Option<String> {
        let (Some(dir), Some(from)) = (&worker.worktree_dir, &worker.worktree_from) else { return None };
        if let Some(sha) = &worker.fork_base_sha {
            return Some(sha.clone());
        }
        self.git.info.merge_base(&PathBuf::from(dir), &PathBuf::from(from)).await
    }

    /// A row the app writes on a worker's timeline itself, announced as a change of the worker.
    pub(crate) async fn note(&self, worker_id: &str, kind: WorkerEventType, payload: Value) -> Result<i64, Error> {
        let (id, now) = (worker_id.to_owned(), self.sessions.clock().now_ms());
        self.store
            .write(move |tx, out| {
                let row_id = tx.events().append_json(&id, now, kind, &payload)?;
                out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id}));
                Ok(row_id)
            })
            .await
    }
}
