//! `GET /api/surfaces/:id/issues?before=&limit=` (newest first) and
//! `GET /api/surfaces/:id/issues/:issueId`. A View issue answers the View and
//! the ids of its bound actions, never their argument templates: the frame
//! names a bound action, the core fills it. With plain reading on, a Page
//! issue also answers its fallback View (`plain`).

use std::sync::Arc;

use eos_contracts::{SurfaceIssue, SurfaceIssueList};
use eos_core::store::StoredIssue;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::IssueKind;
use eos_surface::render::fallback::fallback_view;
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
            let found = at
                .store
                .read(move |tx| {
                    let (issue, surface) = (tx.surface_issues().find(&issue_id)?, tx.surfaces().find(&id)?);
                    let current = match (&issue, &surface) {
                        (Some(issue), Some(surface))
                            if issue.kind == IssueKind::Page && issue.version != surface.current_version =>
                        {
                            match surface.current_version {
                                Some(n) => tx.surface_versions().find(&surface.id, n)?.map(|v| v.body_json),
                                None => None,
                            }
                        }
                        _ => None,
                    };
                    Ok((issue, surface, current))
                })
                .await?;
            let (Some(issue), Some(surface), current) = found else {
                return Err(ApiError::NotFound("issue not found".into()));
            };
            if issue.surface_id != surface.id {
                return Err(ApiError::NotFound("issue not found".into()));
            }
            let mut body = shown_body(&issue);
            // Plain reading shows any page through the fallback, in Eos's look.
            if issue.kind == IssueKind::Page && crate::settings::reading(&at).await?.plain {
                body["plain"] = fallback_view(&surface.title, None, &body["data"]);
            }
            let fits_current = current.map(|design| crate::page::fits(&design, &body["data"]));
            Ok(Response::json(200, &SurfaceIssue { issue: issue_row(&issue), body, fits_current }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read));
    vec![list, one]
}
