//! `GET /api/surfaces/:id/issues?before=&limit=` (newest first) and
//! `GET /api/surfaces/:id/issues/:issueId`. A View issue answers the View and
//! the ids of its bound actions, never their argument templates: the frame
//! names a bound action, the core fills it.

use std::sync::Arc;

use eos_contracts::{SurfaceIssue, SurfaceIssueList};
use eos_core::store::StoredIssue;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::IssueKind;
use serde_json::{Value, json};

use crate::SurfacesParts;
use crate::routes::{param, surface_in};
use crate::wire::issue_row;

const PAGE: i64 = 20;
const PAGE_MAX: i64 = 100;

fn shown_body(issue: &StoredIssue) -> Value {
    let body: Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
    if issue.kind != IssueKind::View {
        return body;
    }
    let bound: Vec<&String> = body["bindings"].as_object().map(|b| b.keys().collect()).unwrap_or_default();
    json!({ "place": body["place"], "view": body["view"], "actions": bound })
}

pub(crate) fn all(parts: &Arc<SurfacesParts>) -> Vec<RouteDef> {
    let at = parts.clone();
    let list = RouteDef::get("/api/surfaces/{id}/issues", move |req: Request| {
        let (at, id) = (at.clone(), param(&req, "id"));
        async move {
            let before = req.query().get("before").map(|b| b.into_owned());
            let limit =
                match req.query().get("limit") {
                    None => PAGE,
                    Some(n) => n.parse::<i64>().ok().filter(|n| (1..=PAGE_MAX).contains(n)).ok_or_else(|| {
                        ApiError::Validation(format!("invalid request: limit: must be 1 to {PAGE_MAX}"))
                    })?,
                };
            let mut rows = at
                .store
                .read(move |tx| {
                    surface_in(tx, &id)?;
                    tx.surface_issues().of_surface(&id, before.as_deref(), limit + 1)
                })
                .await?;
            let more = rows.len() as i64 > limit;
            rows.truncate(usize::try_from(limit).unwrap_or(0));
            Ok(Response::json(200, &SurfaceIssueList { issues: rows.iter().map(issue_row).collect(), more }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read));

    let at = parts.clone();
    let one = RouteDef::get("/api/surfaces/{id}/issues/{issueId}", move |req: Request| {
        let (at, id, issue_id) = (at.clone(), param(&req, "id"), param(&req, "issueId"));
        async move {
            let found = at.store.read(move |tx| tx.surface_issues().find(&issue_id)).await?;
            let issue =
                found.filter(|i| i.surface_id == id).ok_or_else(|| ApiError::NotFound("issue not found".into()))?;
            Ok(Response::json(200, &SurfaceIssue { issue: issue_row(&issue), body: shown_body(&issue) }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read));
    vec![list, one]
}
