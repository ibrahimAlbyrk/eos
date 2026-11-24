//! The designer's two tools (05 §7): `page_design_read` answers what a
//! design run works from, `page_design_propose` hands a design to the
//! pipeline. Only a design run's session of the surface's own routine calls
//! them; what it proposes is checked, never trusted.

use eos_contracts::{RunInput, SurfaceRunInput};
use eos_core::Error;
use eos_core::store::StoredIssue;
use eos_surface::{IssueKind, MadeBy, format_problems};
use serde_json::{Value, json};

use crate::design::{Proposal, Proposed};
use crate::issues::ViewIssues;

/// How many of the newest issues the designer reads the data of.
const ISSUES_READ: usize = 3;

/// The surface run the caller's session works for.
async fn design_run(tools: &ViewIssues, worker_id: &str) -> Result<(String, SurfaceRunInput), Error> {
    let worker = worker_id.to_owned();
    tools
        .store
        .read(move |tx| {
            let run = tx.routine_sessions().run_of(&worker)?;
            let run = run.filter(|run| run.kind == "design");
            let run = run.ok_or_else(|| Error::Validation("the page tools are for a design run's designer".into()))?;
            let stored = tx.runs().find(&run.run_id)?.ok_or_else(|| Error::not_found("run", &run.run_id))?;
            let input: RunInput =
                serde_json::from_str(&stored.input).map_err(|_| Error::storage("a run with no input"))?;
            let asked = input.surface.ok_or_else(|| Error::Validation("this run designs no page".into()))?;
            let surface = tx.surfaces().find(&asked.surface_id)?;
            if surface.is_none_or(|s| s.routine_id != run.routine_id) {
                return Err(Error::Validation("that page belongs to another routine".into()));
            }
            Ok((run.run_id, asked))
        })
        .await
}

pub(crate) async fn read(tools: &ViewIssues, worker_id: &str) -> Result<Value, Error> {
    let (_, asked) = design_run(tools, worker_id).await?;
    let (sid, base) = (asked.surface_id.clone(), asked.base_version);
    let (version, issues) = tools
        .store
        .read(move |tx| {
            let surface = tx.surfaces().find(&sid)?.ok_or_else(|| Error::not_found("surface", &sid))?;
            let number = base.or(surface.current_version);
            let version = match number {
                Some(n) => tx.surface_versions().find(&sid, n)?,
                None => None,
            };
            let issues: Vec<StoredIssue> = tx.surface_issues().of_surface(&sid, None, 20)?;
            Ok((version, issues))
        })
        .await?;
    let data: Vec<Value> = issues
        .iter()
        .filter(|issue| issue.kind == IssueKind::Page)
        .filter_map(|issue| serde_json::from_str::<Value>(&issue.body_json).ok()?.get("data").cloned())
        .take(ISSUES_READ)
        .collect();
    let current = version.map(|v| {
        json!({
            "version": v.version,
            "note": v.note,
            "design": serde_json::from_str::<Value>(&v.body_json).unwrap_or_default(),
        })
    });
    Ok(json!({
        "current": current,
        "instruction": asked.instruction,
        "pointedAt": asked.part.map(|part| json!({ "part": part, "index": asked.index })),
        // The data came from the routine's runs, which read outside text.
        "recentIssues": data,
    }))
}

pub(crate) async fn propose(tools: &ViewIssues, worker_id: &str, design: Value, note: String) -> Result<String, Error> {
    let (run_id, asked) = design_run(tools, worker_id).await?;
    let proposal = Proposal {
        surface_id: asked.surface_id,
        run_id: Some(run_id),
        made_by: MadeBy::Designer,
        base_version: asked.base_version,
        note,
        body: design,
    };
    match tools.designs.propose(proposal).await? {
        Proposed::Refused(problems) => Err(Error::Validation(format_problems(&problems))),
        Proposed::Candidate(version) => Ok(format!(
            "version {version} passed every check and waits for the user. End the run with submit_result, kind `nothing`."
        )),
        Proposed::Waiting(version) => Ok(format!(
            "version {version} passed the static checks and is checked once Eos's window is open. End the run with \
             submit_result, kind `nothing`."
        )),
        Proposed::Failed { version, report } => Err(Error::Validation(failed_line(version, &report))),
    }
}

/// What the probe found, one line each, then where its pictures are.
fn failed_line(version: i64, report: &Value) -> String {
    let mut lines = vec![format!("version {version} failed the layout checks; fix each and propose again:")];
    let mut shots = Vec::new();
    for set in report["probe"].as_array().into_iter().flatten() {
        for width in set["widths"].as_array().into_iter().flatten() {
            for finding in width["findings"].as_array().into_iter().flatten() {
                let part = finding["part"].as_str().map(|p| format!(" in part `{p}`")).unwrap_or_default();
                lines.push(format!(
                    "- {} at {} px with the {}{part}: {}",
                    finding["check"].as_str().unwrap_or_default(),
                    width["width"],
                    set["data"].as_str().unwrap_or_default(),
                    finding["detail"].as_str().unwrap_or_default(),
                ));
            }
            if let Some(shot) = width["screenshot"].as_str() {
                shots.push(shot.to_owned());
            }
        }
    }
    if !shots.is_empty() {
        lines.push(format!("Pictures of the page: {}", shots.join(", ")));
    }
    lines.join("\n")
}
