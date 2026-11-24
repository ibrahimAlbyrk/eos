//! Changing a page's design (05 Q5, gaps 17 and 19): saying what to change
//! starts the page's designer on the version the user saw; Remove, Move up
//! and Move down on a pointed part change the template with no agent. Both
//! make a candidate through the same checks. The user keeps it (the version
//! before is superseded, and runs started from now fill it), goes back
//! (it is discarded), or brings an old version back as a new candidate.
//! Each is told to memory after its write.

use std::sync::Arc;

use eos_contracts::{
    ArrangeRequest, ReshapeRequest, ReshapeStarted, ResultMode, RunInput, SurfaceRunInput, SurfaceRunKind,
    SurfaceVersion, SurfacesChange,
};
use eos_core::Error;
use eos_core::experience::{SurfaceSignal, SurfaceSignalKind};
use eos_core::routine::{NewRun, RunOrigin, StartError};
use eos_core::store::{StoredSurface, StoredSurfaceVersion};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::{ArrangeOp, Level, MadeBy, PageDesign, VersionStatus, arrange, format_problems};
use serde_json::Value;

use crate::design::{Designs, Proposal, Proposed};
use crate::edits::tell;
use crate::routes::param;
use crate::wire::version_meta;
use crate::{SURFACES_CHANGE, SurfacesParts};

fn number(req: &Request) -> Result<i64, ApiError> {
    param(req, "version").parse().map_err(|_| ApiError::NotFound("version not found".into()))
}

fn design_signal(surface: &StoredSurface, kind: SurfaceSignalKind) -> SurfaceSignal {
    SurfaceSignal {
        surface_id: surface.id.clone(),
        routine_id: surface.routine_id.clone(),
        run_id: None,
        issue_id: None,
        kind,
        at: None,
        index: None,
        before: None,
        after: None,
    }
}

/// The page and the version a change starts from, which must be the one
/// the user has or the candidate they are looking at.
async fn base_of(parts: &SurfacesParts, id: String, base: i64) -> Result<(StoredSurface, PageDesign), ApiError> {
    let (surface, row) = parts
        .store
        .read(move |tx| {
            let surface = tx.surfaces().find(&id)?.filter(|s| s.level == Level::Page && s.archived_at.is_none());
            let surface = surface.ok_or_else(|| Error::not_found("page", &id))?;
            Ok((surface.clone(), tx.surface_versions().find(&id, base)?))
        })
        .await?;
    if surface.current_version != Some(base) && surface.candidate_version != Some(base) {
        return Err(ApiError::Conflict("that is no longer the page's design: open it again".into()));
    }
    let row = row.ok_or_else(|| ApiError::NotFound("version not found".into()))?;
    let body: Value = serde_json::from_str(&row.body_json).unwrap_or_default();
    let design = PageDesign::from_body(&body).map_err(|_| ApiError::Conflict("that design no longer reads".into()))?;
    Ok((surface, design))
}

/// The new version as the screen shows it, or why it was not made.
async fn made(parts: &SurfacesParts, surface_id: &str, proposed: Proposed) -> Result<Response, ApiError> {
    let version = match proposed {
        Proposed::Refused(problems) => {
            return Err(ApiError::Conflict(format!("Couldn't make that change: {}", format_problems(&problems))));
        }
        Proposed::Failed { report, .. } => {
            let failed = report["probe"].to_string();
            return Err(ApiError::Conflict(format!("Couldn't make that change: a layout check failed: {failed}")));
        }
        Proposed::Candidate(version) | Proposed::Waiting(version) => version,
    };
    let sid = surface_id.to_owned();
    let row = parts.store.read(move |tx| tx.surface_versions().find(&sid, version)).await?;
    let row = row.ok_or_else(|| ApiError::NotFound("version not found".into()))?;
    Ok(Response::json(200, &version_doc(&row)))
}

fn version_doc(row: &StoredSurfaceVersion) -> SurfaceVersion {
    SurfaceVersion {
        meta: version_meta(row),
        body: serde_json::from_str(&row.body_json).unwrap_or_default(),
        checks: serde_json::from_str(&row.checks_json).unwrap_or_default(),
        access_line: None,
    }
}

fn start_refusal(error: StartError) -> ApiError {
    match error {
        StartError::Store(error) => error.into(),
        StartError::UnknownRoutine(_) => ApiError::NotFound("routine not found".into()),
        StartError::Unready(unready) => ApiError::Conflict(unready.message()),
        StartError::DayCap => ApiError::Conflict("Routines spent today's budget".into()),
        StartError::Halted => ApiError::Conflict("Everything is stopped on this Mac".into()),
        _ => ApiError::Conflict("The routine does not take a design run now".into()),
    }
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>, designs: &Arc<Designs>) -> Vec<RouteDef> {
    vec![reshape(parts), arrange_route(parts, designs), keep(parts), discard(parts), restore(parts, designs)]
}

fn reshape(parts: &Arc<SurfacesParts>) -> RouteDef {
    let at = parts.clone();
    RouteDef::post("/api/surfaces/{id}/reshape", move |req: Request| {
        let (at, id) = (at.clone(), param(&req, "id"));
        async move {
            let asked: ReshapeRequest = req.parse()?;
            let (surface, _) = base_of(&at, id, asked.base_version).await?;
            let new = NewRun {
                routine_id: surface.routine_id.clone(),
                version: None,
                input: RunInput {
                    item: None,
                    items: None,
                    trigger: None,
                    options: Default::default(),
                    note: None,
                    result: ResultMode::ShowOnly,
                    at: None,
                    surface: Some(SurfaceRunInput {
                        kind: SurfaceRunKind::Design,
                        surface_id: surface.id.clone(),
                        base_version: Some(asked.base_version),
                        instruction: Some(asked.instruction.clone()),
                        part: asked.part.clone(),
                        index: asked.index,
                        issue_id: None,
                        item: None,
                    }),
                    chat: None,
                },
                items: Vec::new(),
                origin: RunOrigin::Surface { surface_id: surface.id.clone() },
                door: Some("surface".into()),
                confirm_repeat: true,
                client_request_id: None,
            };
            let made = at.runs.start(new).await.map_err(start_refusal)?;
            let run_id = made.into_iter().next().map(|run| run.id).unwrap_or_default();
            tracing::info!(surface = %surface.id, run_id, "a page's reshape started its designer");
            let mut said = design_signal(&surface, SurfaceSignalKind::Reshaped);
            (said.at, said.index, said.after) = (asked.part, asked.index, Some(Value::String(asked.instruction)));
            tell(&at, vec![said]).await;
            Ok(Response::json(202, &ReshapeStarted { run_id }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}

fn arrange_route(parts: &Arc<SurfacesParts>, designs: &Arc<Designs>) -> RouteDef {
    let (at, designs) = (parts.clone(), designs.clone());
    RouteDef::post("/api/surfaces/{id}/arrange", move |req: Request| {
        let (at, designs, id) = (at.clone(), designs.clone(), param(&req, "id"));
        async move {
            let asked: ArrangeRequest = req.parse()?;
            let op = ArrangeOp::parse(&asked.op)
                .ok_or_else(|| ApiError::Validation("op: remove, move_up or move_down".into()))?;
            let (surface, design) = base_of(&at, id, asked.base_version).await?;
            let body = arrange(&design, &asked.part, op).map_err(ApiError::Conflict)?;
            let note = match op {
                ArrangeOp::Remove => format!("Removed {}", asked.part),
                ArrangeOp::MoveUp => format!("Moved {} up", asked.part),
                ArrangeOp::MoveDown => format!("Moved {} down", asked.part),
            };
            let proposal = Proposal {
                surface_id: surface.id.clone(),
                run_id: None,
                made_by: MadeBy::Arrange,
                base_version: Some(asked.base_version),
                note,
                body,
            };
            let proposed = designs.propose(proposal).await?;
            let mut said = design_signal(&surface, SurfaceSignalKind::Reshaped);
            (said.at, said.after) = (Some(asked.part), Some(Value::String(asked.op)));
            tell(&at, vec![said]).await;
            made(&at, &surface.id, proposed).await
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}

fn changed(out: &mut eos_core::store::Outbox, surface: &StoredSurface) {
    let change = SurfacesChange {
        surface_id: surface.id.clone(),
        routine_id: surface.routine_id.clone(),
        what: "version".into(),
    };
    out.push(SURFACES_CHANGE.name(), &change);
}

fn keep(parts: &Arc<SurfacesParts>) -> RouteDef {
    let at = parts.clone();
    RouteDef::post("/api/surfaces/{id}/versions/{version}/keep", move |req: Request| {
        let (at, id) = (at.clone(), param(&req, "id"));
        async move {
            let n = number(&req)?;
            let now = at.clock.now_ms();
            let (surface, row) = at
                .store
                .write(move |tx, out| {
                    let mut surface = crate::routes::surface_in(tx, &id)?;
                    let mut row = tx
                        .surface_versions()
                        .find(&id, n)?
                        .ok_or_else(|| Error::not_found("version", n.to_string()))?;
                    if surface.candidate_version != Some(n) || !row.status.can_move_to(VersionStatus::Kept) {
                        return Err(Error::Conflict("only the page's candidate that passed its checks is kept".into()));
                    }
                    if let Some(before) = surface.current_version
                        && let Some(mut old) = tx.surface_versions().find(&id, before)?
                        && old.status.can_move_to(VersionStatus::Superseded)
                    {
                        old.status = VersionStatus::Superseded;
                        tx.surface_versions().put(&old)?;
                    }
                    row.status = VersionStatus::Kept;
                    row.kept_at = Some(now);
                    tx.surface_versions().put(&row)?;
                    (surface.current_version, surface.candidate_version, surface.updated_at) = (Some(n), None, now);
                    tx.surfaces().put(&surface)?;
                    changed(out, &surface);
                    Ok((surface, row))
                })
                .await?;
            tracing::info!(surface = %surface.id, version = n, "a page's new design was kept");
            tell(&at, vec![design_signal(&surface, SurfaceSignalKind::KeptDesign)]).await;
            Ok(Response::json(200, &version_doc(&row)))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}

fn discard(parts: &Arc<SurfacesParts>) -> RouteDef {
    let at = parts.clone();
    RouteDef::post("/api/surfaces/{id}/versions/{version}/discard", move |req: Request| {
        let (at, id) = (at.clone(), param(&req, "id"));
        async move {
            let n = number(&req)?;
            let now = at.clock.now_ms();
            let (surface, row) = at
                .store
                .write(move |tx, out| {
                    let mut surface = crate::routes::surface_in(tx, &id)?;
                    let mut row = tx
                        .surface_versions()
                        .find(&id, n)?
                        .ok_or_else(|| Error::not_found("version", n.to_string()))?;
                    if surface.candidate_version != Some(n) || !row.status.can_move_to(VersionStatus::Discarded) {
                        return Err(Error::Conflict("only the page's open candidate can be let go".into()));
                    }
                    row.status = VersionStatus::Discarded;
                    tx.surface_versions().put(&row)?;
                    (surface.candidate_version, surface.updated_at) = (None, now);
                    tx.surfaces().put(&surface)?;
                    changed(out, &surface);
                    Ok((surface, row))
                })
                .await?;
            tell(&at, vec![design_signal(&surface, SurfaceSignalKind::Reverted)]).await;
            Ok(Response::json(200, &version_doc(&row)))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}

fn restore(parts: &Arc<SurfacesParts>, designs: &Arc<Designs>) -> RouteDef {
    let (at, designs) = (parts.clone(), designs.clone());
    RouteDef::post("/api/surfaces/{id}/versions/{version}/restore", move |req: Request| {
        let (at, designs, id) = (at.clone(), designs.clone(), param(&req, "id"));
        async move {
            let n = number(&req)?;
            let sid = id.clone();
            let row = at.store.read(move |tx| tx.surface_versions().find(&sid, n)).await?;
            let row = row.ok_or_else(|| ApiError::NotFound("version not found".into()))?;
            if matches!(row.status, VersionStatus::Checking | VersionStatus::Candidate | VersionStatus::Kept) {
                return Err(ApiError::Conflict("that version is not an earlier one".into()));
            }
            let proposal = Proposal {
                surface_id: id.clone(),
                run_id: None,
                made_by: MadeBy::Restore,
                base_version: Some(n),
                note: format!("Version {n} again"),
                body: serde_json::from_str(&row.body_json).unwrap_or_default(),
            };
            let proposed = designs.propose(proposal).await?;
            made(&at, &id, proposed).await
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}
