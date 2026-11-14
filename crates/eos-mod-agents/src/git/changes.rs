//! What a worker changed, discarding one file of it, and opening its folder.

use std::path::Path;

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{
    ChangedFileStatus, FileDiffQuery, FileDiffResponse, OpenInRequest, OpenInRequestTarget,
    WorkerChangesDiscardRequest, WorkerChangesDiscardResponse, WorkerChangesResponse, WorkerDiffResponse,
};
use eos_core::git::OpResult;
use eos_core::os::OpenIn;
use eos_domain::git::changes::{PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES, attach_patches};
use eos_kit_fs::path::is_repo_relative;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Map, Value, json};

use super::{WorkerGit, no_folder, not_repo_relative};
use crate::AgentsModule;
use crate::routes::id_of;

pub(super) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![diff(m.clone()), changes(m.clone()), file(m.clone()), discard(m.clone()), open(m.clone())]
}

fn diff(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/diff", move |req: Request| {
        let m = m.clone();
        async move {
            let worker = m.worker(&id_of(&req)).await?;
            let Some(dir) = worker.as_ref().and_then(|w| w.readable_work_dir()) else {
                return Ok(Response::json(200, &WorkerDiffResponse { insertions: 0, deletions: 0, files: 0 }));
            };
            let base = match &worker {
                Some(w) => m.diff_base(w).await,
                None => None,
            };
            let stat = m.git().diffs.diff_short_stat(Path::new(dir), base.as_deref()).await;
            let answer = WorkerDiffResponse {
                insertions: stat.insertions.into(),
                deletions: stat.deletions.into(),
                files: stat.files.into(),
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn changes(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/changes", move |req: Request| {
        let m = m.clone();
        async move {
            let empty = WorkerChangesResponse { files: Vec::new(), insertions: 0, deletions: 0 };
            let Some(worker) = m.worker(&id_of(&req)).await? else { return Ok(Response::json(200, &empty)) };
            let Some(dir) = worker.readable_work_dir().map(Path::new) else { return Ok(Response::json(200, &empty)) };
            let base = m.diff_base(&worker).await;
            let diffs = &m.git().diffs;
            // `?patches=1` cuts each file's patch out of one whole-tree diff; a
            // file without one (too large, or no whole diff) is loaded on its own later.
            let mut files = diffs.changed_files(dir, base.as_deref()).await;
            if req.query().get("patches").as_deref() == Some("1")
                && let Some(full) = diffs.full_diff(dir, base.as_deref()).await
            {
                attach_patches(&mut files, &full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
            }
            let answer = WorkerChangesResponse {
                insertions: files.iter().map(|f| f.insertions.unwrap_or(0)).sum(),
                deletions: files.iter().map(|f| f.deletions.unwrap_or(0)).sum(),
                files,
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn file(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/changes/file", move |req: Request| {
        let m = m.clone();
        async move {
            let mut query = Map::new();
            for (name, key) in [("path", "path"), ("oldPath", "oldPath")] {
                if let Some(value) = req.query().get(name) {
                    query.insert(key.to_owned(), Value::String(value.into_owned()));
                }
            }
            let q: FileDiffQuery = eos_contracts::parse(&Value::Object(query))?;
            if !is_repo_relative(&q.path) {
                return Err(not_repo_relative());
            }
            let worker = m.worker(&id_of(&req)).await?;
            let Some(dir) = worker.as_ref().and_then(|w| w.readable_work_dir()) else {
                let empty = FileDiffResponse { path: q.path, patch: String::new(), binary: false, truncated: false };
                return Ok(Response::json(200, &empty));
            };
            let base = match &worker {
                Some(w) => m.diff_base(w).await,
                None => None,
            };
            let old_path = q.old_path.as_deref();
            Ok(Response::json(200, &m.git().diffs.file_diff(Path::new(dir), &q.path, old_path, base.as_deref()).await))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

/// Puts one changed file back as it is at `base` (HEAD when `None`): the
/// reverse of what the changes list shows. Untracked files are removed,
/// tracked ones restored; a renamed file brings its old path back. Whether
/// and how it changed is read anew, so a stale request is a harmless no-op.
pub(crate) async fn discard_file_change(git: &WorkerGit, cwd: &Path, path: &str, base: Option<&str>) -> OpResult {
    let changed = git.diffs.changed_files(cwd, base).await;
    let Some(target) = changed.into_iter().find(|f| f.path == path) else { return OpResult::ok() };
    if target.untracked {
        return git.restore.remove_untracked(cwd, &[path.to_owned()]).await;
    }
    let paths = match target.old_path.filter(|_| target.status == ChangedFileStatus::R) {
        Some(old) => vec![old, path.to_owned()],
        None => vec![path.to_owned()],
    };
    git.restore.restore_to_base(cwd, &paths, base).await
}

fn discard(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/changes/discard", move |req: Request| {
        let m = m.clone();
        async move {
            let body: WorkerChangesDiscardRequest = req.parse()?;
            if !is_repo_relative(&body.path) {
                return Err(not_repo_relative());
            }
            let id = id_of(&req);
            let worker = m.worker(&id).await?;
            let Some(dir) = worker.as_ref().and_then(|w| w.readable_work_dir()) else {
                return Err(ApiError::NotFound("worker has no working directory".into()));
            };
            let base = match &worker {
                Some(w) => m.diff_base(w).await,
                None => None,
            };
            let done = discard_file_change(m.git(), Path::new(dir), &body.path, base.as_deref()).await;
            if done.ok {
                m.store
                    .write(move |_, out| {
                        out.push(WORKER_CHANGE, &json!({"workerId": id}));
                        Ok(())
                    })
                    .await?;
            }
            let answer = WorkerChangesDiscardResponse { ok: done.ok, error: done.error };
            Ok(Response::json(if answer.ok { 200 } else { 409 }, &answer))
        }
    })
    .access(Access::ui_token().phone_user(Tier::High))
}

/// "Open in": the worker's folder, taken from its row and never from the request.
fn open(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/open", move |req: Request| {
        let m = m.clone();
        async move {
            let body: OpenInRequest = req.parse()?;
            let worker = m.existing(&id_of(&req)).await?;
            let dir = worker.work_dir().map(Path::new).filter(|dir| dir.exists()).ok_or_else(no_folder)?;
            let desktop = &m.git().desktop;
            // The file manager opens the folder itself, not its parent with it selected.
            let opened = match body.target {
                OpenInRequestTarget::Finder => desktop.open_path(&dir.to_string_lossy()).await,
                OpenInRequestTarget::Vscode => desktop.open_in(OpenIn::Editor("vscode"), dir, None, None).await,
            };
            opened.map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    })
    .access(Access::ui_token().phone_user(Tier::High))
}
