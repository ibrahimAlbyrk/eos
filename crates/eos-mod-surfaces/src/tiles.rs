//! `GET /api/surfaces/tiles`: each pinned surface as Home's tile shows it
//! (05 Q8). A Page reads its design's tile from its newest ready issue, a
//! View its title and the first line of its summary; with neither, the tile
//! is the surface's title and its routine's status.

use std::sync::Arc;

use eos_contracts::{Tile, TileList};
use eos_core::store::{StoredIssue, StoredSurface};
use eos_runtime::access::{Access, Tier};
use eos_runtime::actions::QueryCall;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::{IssueKind, IssueStatus, PageDesign};
use serde_json::Value;

use crate::SurfacesParts;

/// How many issues back a tile looks for a ready one.
const LOOK_BACK: i64 = 5;
/// The query whose answer every tile carries.
const STATUS_QUERY: &str = "routine.status";

/// A surface, its newest ready issue and the design body that issue was made with.
type Pinned = (u8, StoredSurface, Option<StoredIssue>, Option<String>);

async fn pinned(parts: &SurfacesParts) -> Result<Vec<Pinned>, ApiError> {
    let read = parts.store.read(|tx| {
        let mut out = Vec::new();
        for (slot, id) in tx.surface_pins().list()? {
            let Some(surface) = tx.surfaces().find(&id)? else { continue };
            let issues = tx.surface_issues().of_surface(&id, None, LOOK_BACK)?;
            let issue = issues.into_iter().find(|i| i.status == IssueStatus::Ready);
            let body = match issue.as_ref().filter(|i| i.kind == IssueKind::Page).and_then(|i| i.version) {
                Some(n) => tx.surface_versions().find(&id, n)?.map(|v| v.body_json),
                None => None,
            };
            out.push((slot, surface, issue, body));
        }
        Ok(out)
    });
    Ok(read.await?)
}

/// The tile's words: from the design's tile for a page, from the View.
fn words(
    parts: &SurfacesParts,
    issue: &StoredIssue,
    design: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    let body: Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
    if issue.kind == IssueKind::View {
        let text = |key: &str| body["view"][key].as_str().map(str::to_owned).filter(|t| !t.is_empty());
        let summary = text("summary").and_then(|s| s.lines().next().map(str::to_owned));
        return (text("title"), summary, None);
    }
    let design = design.and_then(|d| serde_json::from_str::<Value>(d).ok());
    let Some(tile) = design.and_then(|d| PageDesign::from_body(&d).ok()).and_then(|d| d.tile) else {
        return (None, None, None);
    };
    let text = tile.text(&body["data"], parts.zone.offset_minutes_at(issue.created_at));
    (Some(text.headline), text.detail, text.action)
}

async fn status(parts: &SurfacesParts, routine_id: &str) -> Option<Value> {
    let registry = parts.actions.registry();
    let query = registry.query(STATUS_QUERY)?;
    let call = QueryCall {
        query_id: STATUS_QUERY.into(),
        routine_id: Some(routine_id.into()),
        args: Value::Object(Default::default()),
    };
    query.handler.read(call).await.ok()
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>) -> Vec<RouteDef> {
    let at = parts.clone();
    let tiles = RouteDef::get("/api/surfaces/tiles", move |_req: Request| {
        let at = at.clone();
        async move {
            let mut tiles = Vec::new();
            for (slot, surface, issue, design) in pinned(&at).await? {
                let (headline, detail, action) = match &issue {
                    Some(issue) => words(&at, issue, design.as_deref()),
                    None => (None, None, None),
                };
                tiles.push(Tile {
                    slot,
                    status: status(&at, &surface.routine_id).await,
                    surface_id: surface.id,
                    routine_id: surface.routine_id,
                    level: surface.level.as_str().to_owned(),
                    title: surface.title,
                    headline,
                    detail,
                    action,
                    issue_id: issue.as_ref().map(|i| i.id.clone()),
                    issued_at: issue.as_ref().map(|i| i.created_at),
                });
            }
            Ok::<_, ApiError>(Response::json(200, &TileList { tiles }))
        }
    })
    .access(Access::open().phone(Tier::Read));
    vec![tiles]
}
