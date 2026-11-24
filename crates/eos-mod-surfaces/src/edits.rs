//! What the reader does on a page issue, told to memory after each commit:
//!
//! - `PUT /api/surfaces/:id/issues/:issueId/fields`: one edit in place the
//!   issue's contract allows, made on the revision the reader saw. Each edit
//!   is a new revision and a row of `surface_edits` with the value before and
//!   after, announced on `surfaces:issue`;
//! - `POST …/issues/:issueId/read`: the parts the reader opened, first one
//!   first, and the parts whose links they followed (ids and indexes only).

use std::sync::Arc;

use eos_contracts::{IssueFieldEdit, IssueReadReport, SurfaceIssue};
use eos_core::Error;
use eos_core::experience::{SurfaceSignal, SurfaceSignalKind};
use eos_core::store::{StoredIssue, StoredSurfaceEdit};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::{Contract, FieldEdit, IssueKind, apply_edit};
use serde_json::{Value, json};

use crate::SurfacesParts;
use crate::fill::announce;
use crate::routes::param;
use crate::wire::issue_row;

fn edit_of(asked: &IssueFieldEdit) -> Result<FieldEdit, ApiError> {
    let path = asked.path.clone();
    let needs = |what: &str| ApiError::Validation(format!("invalid request: {what}: required for {}", asked.op));
    Ok(match asked.op.as_str() {
        "set" => FieldEdit::Set { path, value: asked.value.clone().ok_or_else(|| needs("value"))? },
        "move" => FieldEdit::Move {
            path,
            from: asked.from.ok_or_else(|| needs("from"))?,
            to: asked.to.ok_or_else(|| needs("to"))?,
        },
        _ => FieldEdit::Remove { path, index: asked.from.ok_or_else(|| needs("from"))? },
    })
}

fn signal(issue: &StoredIssue, routine_id: &str, kind: SurfaceSignalKind) -> SurfaceSignal {
    SurfaceSignal {
        surface_id: issue.surface_id.clone(),
        routine_id: routine_id.to_owned(),
        run_id: issue.run_id.clone(),
        issue_id: issue.id.clone(),
        kind,
        at: None,
        index: None,
        before: None,
        after: None,
    }
}

/// Hands signals to memory; one that is not heard costs nothing the user sees.
async fn tell(parts: &SurfacesParts, signals: Vec<SurfaceSignal>) {
    for signal in signals {
        let kind = signal.kind.as_str();
        if let Err(e) = parts.feedback.surface_signal(signal).await {
            tracing::warn!(kind, error = %e, "memory did not hear a surface signal");
        }
    }
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>) -> Vec<RouteDef> {
    let at = parts.clone();
    let fields = RouteDef::put("/api/surfaces/{id}/issues/{issueId}/fields", move |req: Request| {
        let (at, id, issue_id) = (at.clone(), param(&req, "id"), param(&req, "issueId"));
        async move {
            let asked: IssueFieldEdit = req.parse()?;
            let edit = edit_of(&asked)?;
            let now = at.clock.now_ms();
            let (issue, routine_id, before, after) = at
                .store
                .write(move |tx, out| {
                    let surface = tx.surfaces().find(&id)?.ok_or_else(|| Error::not_found("surface", &id))?;
                    let issue = tx.surface_issues().find(&issue_id)?;
                    let mut issue = issue
                        .filter(|i| i.surface_id == id && i.kind == IssueKind::Page)
                        .ok_or_else(|| Error::not_found("issue", &issue_id))?;
                    if issue.rev != asked.base_rev {
                        return Err(Error::Conflict(format!("the issue is at revision {}: reload it", issue.rev)));
                    }
                    let number = issue.version.ok_or_else(|| Error::not_found("version", &issue_id))?;
                    let version = tx.surface_versions().find(&id, number)?;
                    let version = version.ok_or_else(|| Error::not_found("version", number.to_string()))?;
                    let body: Value = serde_json::from_str(&version.body_json).unwrap_or_default();
                    let contract = Contract::parse(&body["contract"])
                        .map_err(|_| Error::Conflict("this design no longer reads as a page".into()))?;
                    let mut stored: Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
                    let edited = apply_edit(&contract, &stored["data"], &edit).map_err(Error::Validation)?;
                    stored["data"] = edited.data;
                    issue.body_json = stored.to_string();
                    issue.rev += 1;
                    issue.updated_at = now;
                    tx.surface_issues().put(&issue)?;
                    tx.surface_edits().insert(&StoredSurfaceEdit {
                        issue_id: issue.id.clone(),
                        rev: issue.rev,
                        op: edit.op().to_owned(),
                        path: edit.path().to_owned(),
                        before_json: edited.before.to_string(),
                        after_json: edited.after.to_string(),
                        at: now,
                    })?;
                    announce(out, &issue);
                    Ok((issue, surface.routine_id, edited.before, edited.after))
                })
                .await?;
            tracing::info!(surface_id = %issue.surface_id, issue_id = %issue.id, rev = issue.rev, "an issue was edited");
            let path = asked.path;
            let mut edited = signal(&issue, &routine_id, SurfaceSignalKind::Edited);
            (edited.at, edited.before, edited.after) = (Some(path), Some(before), Some(after));
            tell(&at, vec![edited]).await;
            let body: Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
            Ok(Response::json(200, &SurfaceIssue { issue: issue_row(&issue), body }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low));

    let at = parts.clone();
    let read = RouteDef::post("/api/surfaces/{id}/issues/{issueId}/read", move |req: Request| {
        let (at, id, issue_id) = (at.clone(), param(&req, "id"), param(&req, "issueId"));
        async move {
            let report: IssueReadReport = req.parse()?;
            let found =
                at.store.read(move |tx| Ok((tx.surface_issues().find(&issue_id)?, tx.surfaces().find(&id)?))).await?;
            let (Some(issue), Some(surface)) = found else { return Err(ApiError::NotFound("issue not found".into())) };
            if issue.surface_id != surface.id {
                return Err(ApiError::NotFound("issue not found".into()));
            }
            let opened = report.parts.iter().enumerate().map(|(n, read)| {
                let kind = if n == 0 { SurfaceSignalKind::ReadFirst } else { SurfaceSignalKind::Opened };
                (kind, read)
            });
            let links = report.links.iter().map(|read| (SurfaceSignalKind::Opened, read));
            let signals = opened
                .chain(links)
                .map(|(kind, read)| {
                    let mut s = signal(&issue, &surface.routine_id, kind);
                    (s.at, s.index) = (Some(read.part.clone()), read.index);
                    s
                })
                .collect();
            tell(&at, signals).await;
            Ok(Response::json(200, &json!({})))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low));
    vec![fields, read]
}
