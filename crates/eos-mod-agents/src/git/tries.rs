//! Try: a worker's work applied to the user's checkout as unstaged edits,
//! then kept or discarded. Everything that changes the checkout needs the
//! user's own dashboard, so an agent that can reach the routes cannot apply
//! its own work. Keep and discard name the Try by the body's `workerId` (the
//! card's owner, perhaps a worker since removed); the path's worker only
//! names the checkout.

use std::path::{Path, PathBuf};

use eos_contracts::{
    ActiveTry, TryDiscardResponse, TryKeepResponse, TryStateResponse, TryTargetRequest, WorkerEventType,
};
use eos_core::git::{TryApplied, TryDiscarded, TrySync};
use eos_domain::worker::BranchUnready;
use eos_domain::{Worker, WorkerBranch};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Map, Value, json};

use crate::AgentsModule;
use crate::routes::id_of;

pub(super) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![preview(m.clone()), state(m.clone()), apply(m.clone()), keep(m.clone()), discard(m.clone())]
}

/// The worker's branch to apply, or why there is none yet.
async fn branch_of(m: &AgentsModule, id: &str) -> Result<WorkerBranch, ApiError> {
    let worker = m.existing(id).await?;
    worker.branch_ref().map_err(|unready| match unready {
        BranchUnready::NoBranch => ApiError::Conflict("worker has no worktree branch".into()),
        BranchUnready::NotReady => ApiError::Conflict("worktree not registered yet — retry shortly".into()),
    })
}

/// The checkout a worker's Tries land in: the repository it forks from, or its own folder.
fn checkout_of(worker: Option<&Worker>) -> Option<PathBuf> {
    let worker = worker?;
    worker.worktree_from.as_ref().or(worker.cwd.as_ref()).map(PathBuf::from)
}

fn preview(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/try/preview", move |req: Request| {
        let m = m.clone();
        async move {
            let branch = branch_of(&m, &id_of(&req)).await?;
            Ok(Response::json(200, &m.git().tries.preview(&branch).await))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn state(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/try/state", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let worker = m.existing(&id).await?;
            let Some(checkout) = checkout_of(Some(&worker)) else {
                let none =
                    TryStateResponse { active_tries: Vec::new(), kept: false, syncable: false, sync_files: Vec::new() };
                return Ok(Response::json(200, &none));
            };
            let tries = &m.git().tries;
            // Only a worktree on disk has something to sync.
            let sync = match worker.branch_ref() {
                Ok(branch) => tries.sync_status(&branch).await,
                Err(_) => TrySync::default(),
            };
            let answer = TryStateResponse {
                active_tries: tries.active_tries(&checkout).await,
                kept: tries.was_kept(&checkout, &id).await,
                syncable: sync.syncable,
                sync_files: sync.files,
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn refusal(reason: &str, files: Option<Vec<String>>, detail: Option<String>) -> Value {
    let mut answer = Map::new();
    answer.insert("ok".into(), false.into());
    answer.insert("reason".into(), reason.into());
    if let Some(files) = files {
        answer.insert("files".into(), files.into());
    }
    if let Some(detail) = detail {
        answer.insert("detail".into(), detail.into());
    }
    Value::Object(answer)
}

fn apply(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/try", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let branch = branch_of(&m, &id).await?;
            match m.git().tries.apply(&branch).await {
                TryApplied::Applied { files, lockfile_changed } => {
                    let note = json!({"branch": branch.branch, "files": files, "lockfileChanged": lockfile_changed});
                    m.note(&id, WorkerEventType::TryApplied, note).await?;
                    Ok(Response::json(200, &json!({"ok": true, "files": files, "lockfileChanged": lockfile_changed})))
                }
                TryApplied::Refused { reason, files, detail } => {
                    Ok(Response::json(409, &refusal(reason.as_str(), files, detail)))
                }
            }
        }
    })
    .access(Access::ui_token().phone(Tier::High))
}

/// The open Try of `worker_id` in `checkout`, before it is kept or discarded.
async fn open_try(m: &AgentsModule, checkout: &Path, worker_id: &str) -> Option<ActiveTry> {
    m.git().tries.active_tries(checkout).await.into_iter().find(|t| t.worker_id == worker_id)
}

fn keep(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/try/keep", move |req: Request| {
        let m = m.clone();
        async move {
            let body: TryTargetRequest = req.parse()?;
            let worker = m.worker(&id_of(&req)).await?;
            let checkout = checkout_of(worker.as_ref()).ok_or_else(super::not_found)?;
            let open = open_try(&m, &checkout, &body.worker_id).await;
            if !m.git().tries.keep(&checkout, &body.worker_id).await {
                let answer = TryKeepResponse { ok: false, reason: Some("no-active-try".into()) };
                return Ok(Response::json(409, &answer));
            }
            if let Some(kept) = open {
                m.note(&kept.worker_id, WorkerEventType::TryKept, json!({"branch": kept.branch, "files": kept.files}))
                    .await?;
            }
            Ok(Response::json(200, &TryKeepResponse { ok: true, reason: None }))
        }
    })
    .access(Access::ui_token().phone(Tier::High))
}

fn discard(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/try/discard", move |req: Request| {
        let m = m.clone();
        async move {
            let body: TryTargetRequest = req.parse()?;
            let worker = m.worker(&id_of(&req)).await?;
            let checkout = checkout_of(worker.as_ref()).ok_or_else(super::not_found)?;
            let open = open_try(&m, &checkout, &body.worker_id).await;
            let answer = match m.git().tries.discard(&checkout, &body.worker_id).await {
                TryDiscarded::Discarded => TryDiscardResponse { ok: true, reason: None, files: None, detail: None },
                TryDiscarded::Refused { reason, files, detail } => {
                    let answer = TryDiscardResponse { ok: false, reason: Some(reason.as_str().into()), files, detail };
                    return Ok(Response::json(409, &answer));
                }
            };
            if let Some(gone) = open {
                let note = json!({"branch": gone.branch, "files": gone.files});
                m.note(&gone.worker_id, WorkerEventType::TryDiscarded, note).await?;
            }
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::ui_token().phone(Tier::High))
}

/// `git.autoApplyOnReport`: a finished worker's work lands in the user's
/// checkout as an apply would bring it. Runs on its own: a refusal (a
/// conflict, the user's own edits, another Try in the way) is logged and left
/// to the Apply button; nothing is half applied.
pub(crate) fn auto_apply(m: &AgentsModule, worker: &Worker) {
    let (Some(repo_root), Some(branch), Some(worktree_dir)) =
        (&worker.worktree_from, &worker.branch, &worker.worktree_dir)
    else {
        return;
    };
    let branch = WorkerBranch {
        repo_root: PathBuf::from(repo_root),
        worktree_dir: Some(PathBuf::from(worktree_dir)),
        branch: branch.clone(),
        worker_id: worker.id.clone(),
    };
    let m = m.clone();
    tokio::spawn(async move {
        match m.git().tries.apply(&branch).await {
            TryApplied::Applied { files, lockfile_changed } => {
                let note =
                    json!({"branch": branch.branch, "files": files, "lockfileChanged": lockfile_changed, "auto": true});
                if let Err(e) = m.note(&branch.worker_id, WorkerEventType::TryApplied, note).await {
                    tracing::warn!(worker = branch.worker_id, error = %e, "auto-apply could not be noted");
                }
            }
            TryApplied::Refused { reason, detail, .. } => {
                tracing::warn!(worker = branch.worker_id, reason = reason.as_str(), ?detail, "auto-apply skipped");
            }
        }
    });
}
