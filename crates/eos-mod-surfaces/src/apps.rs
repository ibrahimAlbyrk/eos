//! `app_propose` (05 Q7): a session of a run of a routine that makes an App
//! (its project run, or an App build) hands in the App's code, manifest
//! and tests. Eos's static scan refuses every way out of the frame and
//! every bridge name its manifest does not declare; what passes is written
//! as the App's version `checking`, its one open candidate, which nobody
//! sees until its review and its tests pass. With Apps switched off in
//! Settings nothing is taken.

use eos_contracts::SettingValue;
use eos_core::Error;
use eos_core::store::StoredSurfaceVersion;
use eos_genui::wire::{DEFAULT_APPS, SETTING_APPS};
use eos_surface::{AppDesign, Level, MadeBy, Problem, VersionStatus, format_problems};
use serde_json::{Value, json};

use crate::design::{announce, discard_open};
use crate::issues::ViewIssues;

/// The runs whose sessions build an App.
const BUILD_RUNS: [&str; 2] = ["project", "app-build"];

/// Whether Apps are on in Settings: off, every App shows its summary only
/// and none is taken.
pub(crate) fn apps_on(parts: &crate::SurfacesParts) -> bool {
    match parts.settings.read().get(SETTING_APPS) {
        Some(SettingValue::Flag(on)) => *on,
        _ => DEFAULT_APPS,
    }
}

/// The App, or every problem Eos's scan found.
fn scanned(tools: &ViewIssues, body: &Value) -> Result<AppDesign, Vec<Problem>> {
    let registry = tools.actions.registry();
    let app = AppDesign::from_body(body, |id| registry.action(id).is_some())?;
    let mut problems = Vec::new();
    for (n, id) in app.manifest.uses.iter().enumerate().filter(|(_, id)| registry.action(id).is_none()) {
        problems.push(Problem::new(format!("manifest.uses[{n}]"), format!("`{id}` is no action Eos has")));
    }
    for (n, id) in app.manifest.queries.iter().enumerate().filter(|(_, id)| registry.query(id).is_none()) {
        problems.push(Problem::new(format!("manifest.queries[{n}]"), format!("`{id}` is no query Eos has")));
    }
    if problems.is_empty() { Ok(app) } else { Err(problems) }
}

pub(crate) async fn propose(tools: &ViewIssues, worker_id: &str, body: Value, note: String) -> Result<String, Error> {
    if !apps_on(&tools.parts) {
        return Err(Error::Validation("Apps are switched off in Settings: make a Page or a View instead.".into()));
    }
    let app = scanned(tools, &body).map_err(|problems| Error::Validation(format_problems(&problems)))?;
    let text = app.to_body().to_string();
    let (worker, now) = (worker_id.to_owned(), tools.clock.now_ms());
    let (surface_id, version) = tools
        .store
        .write(move |tx, out| {
            let run = tx.routine_sessions().run_of(&worker)?.filter(|run| BUILD_RUNS.contains(&run.kind.as_str()));
            let run = run.ok_or_else(|| Error::Validation("app_propose is for a session that builds an App".into()))?;
            let surface = tx
                .surfaces()
                .list(Some(&run.routine_id), None)?
                .into_iter()
                .find(|surface| surface.level == Level::App && surface.archived_at.is_none());
            let mut surface = surface.ok_or_else(|| Error::Validation("this routine makes no App".into()))?;
            discard_open(tx, &surface)?;
            let version = tx.surface_versions().next_number(&surface.id)?;
            tx.surface_versions().put(&StoredSurfaceVersion {
                surface_id: surface.id.clone(),
                version,
                status: VersionStatus::Checking,
                base_version: surface.current_version,
                made_by: MadeBy::Builder,
                run_id: Some(run.run_id),
                note,
                body_bytes: text.len() as i64,
                body_json: text,
                checks_json: json!({ "passed": null, "scan": "passed" }).to_string(),
                created_at: now,
                kept_at: None,
            })?;
            surface.candidate_version = Some(version);
            surface.updated_at = now;
            tx.surfaces().put(&surface)?;
            announce(out, &surface, version, "checking");
            Ok((surface.id, version))
        })
        .await?;
    tracing::info!(surface = %surface_id, version, "an App passed Eos's scan");
    Ok(format!(
        "version {version} passed Eos's scan and waits for its review and its tests; the user sees it only once \
         both pass."
    ))
}
