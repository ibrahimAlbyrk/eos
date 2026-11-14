//! A merge conflict in a worker's folder, resolved from the dashboard.
//! Resolving writes a file and stages it, so only the user's own dashboard may
//! do it.

use std::path::Path;

use eos_contracts::{
    ConflictDocumentResponse, ConflictDocumentResponseStyle, ConflictFile, ConflictKind, ConflictListResponse,
    ResolveConflictRequest, ResolveConflictRequestSide, ResolveConflictResponse, WorkerEventType,
};
use eos_core::git::{CommandFailed, ConflictSide};
use eos_domain::git::conflict::{assemble_resolution, classify_conflict, fingerprint_of, parse_conflict_markers};
use eos_kit_fs::path::is_repo_relative;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use super::{WorkerGit, not_repo_relative};
use crate::AgentsModule;
use crate::routes::id_of;

pub(super) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![list(m.clone()), document(m.clone()), resolve(m.clone())]
}

pub(crate) async fn list_conflicts(git: &WorkerGit, cwd: &Path) -> ConflictListResponse {
    let entries = git.info.conflict_list(cwd).await;
    let files =
        entries.into_iter().map(|e| ConflictFile { kind: classify_conflict(&e.xy), path: e.path, xy: e.xy }).collect();
    ConflictListResponse { files }
}

/// One conflicted file as hunks for the resolver; `None` once it is no longer
/// in conflict. An add/delete conflict has no markers: a whole-file choice.
pub(crate) async fn conflict_document(git: &WorkerGit, cwd: &Path, path: &str) -> Option<ConflictDocumentResponse> {
    let entry = git.info.conflict_list(cwd).await.into_iter().find(|e| e.path == path)?;
    let kind = classify_conflict(&entry.xy);
    if kind != ConflictKind::Content {
        return Some(ConflictDocumentResponse {
            path: path.to_owned(),
            kind,
            style: ConflictDocumentResponseStyle::None,
            segments: Vec::new(),
            conflict_count: 0,
            fingerprint: String::new(),
        });
    }
    let content = git.diffs.conflict_file_content(cwd, path).await;
    let doc = parse_conflict_markers(&content);
    Some(ConflictDocumentResponse {
        path: path.to_owned(),
        kind,
        style: doc.style,
        segments: doc.segments,
        conflict_count: doc.conflict_count,
        fingerprint: fingerprint_of(&content),
    })
}

fn refused(remaining: usize, reason: &str, unresolved: Vec<i64>) -> ResolveConflictResponse {
    ResolveConflictResponse {
        ok: false,
        staged: false,
        unresolved,
        remaining: i64::try_from(remaining).unwrap_or(i64::MAX),
        reason: Some(reason.to_owned()),
    }
}

/// Applies the user's resolution of one file and stages it. A content
/// conflict is parsed anew and checked against the fingerprint it was shown
/// with; nothing is written while a hunk is unresolved. `remaining` is how
/// many files are still in conflict.
pub(crate) async fn resolve_conflict_file(
    git: &WorkerGit,
    cwd: &Path,
    req: &ResolveConflictRequest,
) -> Result<ResolveConflictResponse, CommandFailed> {
    let entries = git.info.conflict_list(cwd).await;
    let Some(entry) = entries.iter().find(|e| e.path == req.path) else {
        return Ok(refused(entries.len(), "not-conflicted", Vec::new()));
    };
    let kind = classify_conflict(&entry.xy);
    if kind != ConflictKind::Content {
        let side = match req.side {
            Some(ResolveConflictRequestSide::Ours) => ConflictSide::Ours,
            Some(ResolveConflictRequestSide::Theirs) => ConflictSide::Theirs,
            None => return Ok(refused(entries.len(), "incomplete", Vec::new())),
        };
        git.conflicts.take_side(cwd, &req.path, side, kind).await?;
    } else {
        let content = git.diffs.conflict_file_content(cwd, &req.path).await;
        if req.fingerprint.as_deref().is_some_and(|f| !f.is_empty() && f != fingerprint_of(&content)) {
            return Ok(refused(entries.len(), "stale", Vec::new()));
        }
        let doc = parse_conflict_markers(&content);
        if doc.style == ConflictDocumentResponseStyle::Unparseable {
            return Ok(refused(entries.len(), "unparseable", Vec::new()));
        }
        let resolved = assemble_resolution(&doc, req.resolutions.as_deref().unwrap_or_default());
        if !resolved.unresolved.is_empty() {
            return Ok(refused(entries.len(), "incomplete", resolved.unresolved));
        }
        git.conflicts.write_resolved(cwd, &req.path, &resolved.content).await?;
    }
    let remaining = git.info.conflict_count(cwd).await;
    Ok(ResolveConflictResponse {
        ok: true,
        staged: true,
        unresolved: Vec::new(),
        remaining: remaining.into(),
        reason: None,
    })
}

fn list(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/conflicts", move |req: Request| {
        let m = m.clone();
        async move {
            let worker = m.worker(&id_of(&req)).await?;
            let answer = match worker.as_ref().and_then(|w| w.readable_work_dir()) {
                Some(dir) => list_conflicts(m.git(), Path::new(dir)).await,
                None => ConflictListResponse { files: Vec::new() },
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn no_folder() -> ApiError {
    ApiError::NotFound("worker has no working directory".into())
}

fn document(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/conflicts/file", move |req: Request| {
        let m = m.clone();
        async move {
            let path = req.query().get("path").map(|p| p.into_owned()).unwrap_or_default();
            if !is_repo_relative(&path) {
                return Err(not_repo_relative());
            }
            let worker = m.worker(&id_of(&req)).await?;
            let dir = worker.as_ref().and_then(|w| w.readable_work_dir()).ok_or_else(no_folder)?;
            let doc = conflict_document(m.git(), Path::new(dir), &path).await;
            let doc = doc.ok_or_else(|| ApiError::NotFound("not conflicted".into()))?;
            Ok(Response::json(200, &doc))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn resolve(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/conflicts/resolve", move |req: Request| {
        let m = m.clone();
        async move {
            let body: ResolveConflictRequest = req.parse()?;
            if !is_repo_relative(&body.path) {
                return Err(not_repo_relative());
            }
            let id = id_of(&req);
            let worker = m.worker(&id).await?;
            let dir = worker.as_ref().and_then(|w| w.readable_work_dir()).ok_or_else(no_folder)?;
            let result = resolve_conflict_file(m.git(), Path::new(dir), &body)
                .await
                .map_err(|e| ApiError::Internal(e.to_string()))?;
            if result.ok {
                let payload = json!({"path": body.path, "remaining": result.remaining});
                m.note(&id, WorkerEventType::ConflictResolved, payload).await?;
            }
            Ok(Response::json(if result.ok { 200 } else { 409 }, &result))
        }
    })
    .access(Access::ui_token().phone(Tier::Low))
}
