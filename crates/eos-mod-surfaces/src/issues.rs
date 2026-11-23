//! `return_view`: a run of a routine whose surface is a View hands its View
//! back; the core checks it as `present` does, then that every `send` is
//! bound to an action the routine may run and that nothing prefills a chat,
//! and stores it as an issue of the routine's View surface, announced on
//! `surfaces:issue`. A trial run's issue is a trial issue, with no number.

use std::sync::Arc;

use eos_contracts::SurfacesIssue;
use eos_core::store::{Store, StoredIssue, Tx};
use eos_core::surface::{ReturnedView, SurfaceTools};
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_genui::{ViewValidation, validate_view};
use eos_runtime::actions::Actions;
use eos_surface::{Binding, IssueKind, IssueStatus, Level, Problem, format_problems, view_check};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::SURFACES_ISSUE;

const PLACES: [&str; 2] = ["result", "question"];

pub(crate) struct ViewIssues {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) actions: Actions,
}

/// Every problem of the View and its bindings, or the bindings.
fn checked(actions: &Actions, returned: &ReturnedView) -> Result<Vec<Binding>, Vec<Problem>> {
    let mut problems = Vec::new();
    if !PLACES.contains(&returned.place.as_str()) {
        problems.push(Problem::new("place", "must be result or question"));
    }
    let genui = eos_genui::Value::deserialize(&returned.view).unwrap_or(eos_genui::Value::Null);
    if let ViewValidation::Rejected { problems: found, .. } = validate_view(&genui) {
        problems.extend(found.into_iter().map(|p| Problem::new(format!("view.{}", p.path), p.message)));
        return Err(problems);
    }
    let registry = actions.registry();
    match view_check(&returned.view, returned.bindings.as_ref(), |id| registry.action(id).is_some()) {
        Ok(bindings) if problems.is_empty() => Ok(bindings),
        Ok(_) => Err(problems),
        Err(found) => {
            problems.extend(found);
            Err(problems)
        }
    }
}

fn stored_body(returned: &ReturnedView, bindings: &[Binding]) -> Value {
    let bound: Map<String, Value> =
        bindings.iter().map(|b| (b.view_action.clone(), json!({ "action": b.action, "args": b.args }))).collect();
    json!({ "place": returned.place, "view": returned.view, "bindings": bound })
}

fn store_in(tx: &dyn Tx, worker_id: &str, body: &Value, now: i64, ids: &dyn Ids) -> Result<StoredIssue, Error> {
    let run = tx.routine_sessions().run_of(worker_id)?;
    let run = run.ok_or_else(|| Error::Validation("return_view is for a routine run's sessions".into()))?;
    let surfaces = tx.surfaces().list(Some(&run.routine_id), None)?;
    let surface = surfaces.into_iter().find(|s| s.level == Level::View);
    let surface = surface
        .ok_or_else(|| Error::Validation("this routine makes no view: hand in the result with submit_result".into()))?;
    let trial = run.kind == "trial";
    let issue = StoredIssue {
        id: ids.surface_issue_id(),
        surface_id: surface.id.clone(),
        seq: if trial { None } else { Some(tx.surface_issues().next_seq(&surface.id)?) },
        run_id: Some(run.run_id),
        version: None,
        kind: IssueKind::View,
        status: IssueStatus::Ready,
        body_json: body.to_string(),
        rev: 1,
        images_json: "[]".into(),
        trial,
        kept: false,
        created_at: now,
        updated_at: now,
    };
    tx.surface_issues().put(&issue)?;
    Ok(issue)
}

impl SurfaceTools for ViewIssues {
    fn return_view<'a>(&'a self, worker_id: &'a str, returned: ReturnedView) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let bindings = checked(&self.actions, &returned).map_err(|p| Error::Validation(format_problems(&p)))?;
            let body = stored_body(&returned, &bindings);
            let (worker, now, ids) = (worker_id.to_owned(), self.clock.now_ms(), self.ids.clone());
            let issue = self
                .store
                .write(move |tx, out| {
                    let issue = store_in(tx, &worker, &body, now, ids.as_ref())?;
                    let change = SurfacesIssue {
                        surface_id: issue.surface_id.clone(),
                        issue_id: issue.id.clone(),
                        status: issue.status.as_str().to_owned(),
                        rev: issue.rev,
                    };
                    out.push(SURFACES_ISSUE.name(), &change);
                    Ok(issue)
                })
                .await?;
            tracing::info!(surface = %issue.surface_id, issue = %issue.id, bound = bindings.len(), "a run returned a view");
            let n = bindings.len();
            Ok(format!("issue {} · {n} bound action{}", issue.id, if n == 1 { "" } else { "s" }))
        })
    }
}
