//! A page is designed before it is tried (05 gap 18): the trial of a
//! routine whose version makes a page with no design yet starts the page's
//! design run first, and the trial waits for it; a design run already under
//! way is waited for, never started twice.

use std::sync::Arc;

use eos_contracts::{ResultMode, RunInput, SurfaceRunInput, SurfaceRunKind};
use eos_core::routine::{NewRun, RunOrigin, StartError};
use eos_surface::Level;

use crate::engine::{Engine, start_runs};
use crate::routes::readable;
use crate::trial::version_in;

/// Why the trial waits: the design run that makes the page first.
pub(crate) struct DesignFirst {
    pub(crate) run_id: String,
}

/// The design run the trial of `routine_id` waits for, started now when
/// there is none; `None` when the routine's page has a design, or it makes
/// no page.
pub(crate) async fn design_first(engine: &Arc<Engine>, routine_id: &str) -> Result<Option<DesignFirst>, StartError> {
    let id = routine_id.to_owned();
    let version = engine.store.read(move |tx| version_in(tx, &id)).await?;
    let version = version.ok_or_else(|| StartError::UnknownRoutine(routine_id.to_owned()))?;
    let blueprint = readable(&version)?.ok_or(StartError::NewerFormat)?;
    if blueprint.makes.kind != "page" {
        return Ok(None);
    }
    crate::engine::surfaces::created(engine, routine_id, &version.id, "page").await;
    let id = routine_id.to_owned();
    let (surface, running) = engine
        .store
        .read(move |tx| {
            let page = tx.surfaces().of_routine(&id)?.into_iter().find(|s| s.level == Level::Page);
            let page = page.filter(|s| s.current_version.is_none() && s.candidate_version.is_none());
            let running = tx.runs().live_of(&id)?.into_iter().find(|run| run.kind == SurfaceRunKind::Design.word());
            Ok((page.map(|s| s.id), running.map(|run| run.id)))
        })
        .await?;
    let Some(surface_id) = surface else { return Ok(None) };
    if let Some(run_id) = running {
        return Ok(Some(DesignFirst { run_id }));
    }
    let new = NewRun {
        routine_id: routine_id.to_owned(),
        version: Some(version.id),
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
                surface_id: surface_id.clone(),
                base_version: None,
                instruction: None,
                part: None,
                index: None,
                issue_id: None,
                item: None,
            }),
            chat: None,
        },
        items: Vec::new(),
        origin: RunOrigin::Surface { surface_id },
        door: None,
        confirm_repeat: true,
        client_request_id: None,
    };
    let run_id = start_runs(engine, new).await?.into_iter().next().map(|run| run.id).unwrap_or_default();
    tracing::info!(routine_id, run_id, "a page is designed before its trial");
    Ok(Some(DesignFirst { run_id }))
}
