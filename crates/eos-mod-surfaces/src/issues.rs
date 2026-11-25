//! `return_view`: a run of a routine whose surface is a View hands its View
//! back; the core checks it as `present` does, then that every `send` is
//! bound to an action the routine may run and that nothing prefills a chat,
//! and stores it as an issue of the routine's View surface, announced on
//! `surfaces:issue`. A trial run's issue is a trial issue, with no number.
//! A real run's View opens its Needs-you item in the same job; a question
//! View waits there for the user's answer and hands it back to the run.
//! The facts of its options and its notes are kept beside it, and a View of
//! a run that read outside text is marked so.

use std::sync::Arc;

use eos_contracts::{AsideNote, OptionFacts, SurfacesIssue};
use eos_core::store::{Outbox, Store, StoredIssue, Tx};
use eos_core::surface::{ReturnedView, SurfaceTools, ViewCard, ViewCards};
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_domain::run_scope::Trust;
use eos_genui::{ViewValidation, validate_view};
use eos_runtime::actions::Actions;
use eos_surface::{Binding, IssueKind, IssueStatus, Level, Problem, format_problems, view_check};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::SURFACES_ISSUE;

const PLACES: [&str; 2] = ["result", "question"];
const QUESTION: &str = "question";

pub(crate) struct ViewIssues {
    pub(crate) parts: Arc<crate::SurfacesParts>,
    pub(crate) fills: Arc<crate::fill::Fills>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) actions: Actions,
    pub(crate) cards: Arc<dyn ViewCards>,
    pub(crate) designs: Arc<crate::design::Designs>,
}

/// What a returned View holds once checked: its bindings, the facts of its
/// options and its notes.
struct Checked {
    bindings: Vec<Binding>,
    facts: Option<Vec<OptionFacts>>,
    aside: Option<Vec<AsideNote>>,
}

/// Every problem of the View, its bindings, facts and notes, or what it holds.
fn checked(actions: &Actions, returned: &ReturnedView) -> Result<Checked, Vec<Problem>> {
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
    let bindings = view_check(&returned.view, returned.bindings.as_ref(), |id| registry.action(id).is_some());
    let notes = crate::view_notes::checked(&returned.view, returned.facts.as_ref(), returned.aside.as_ref());
    match (bindings, notes) {
        (Ok(bindings), Ok((facts, aside))) if problems.is_empty() => Ok(Checked { bindings, facts, aside }),
        (bindings, notes) => {
            problems.extend(bindings.err().into_iter().flatten());
            problems.extend(notes.err().into_iter().flatten());
            Err(problems)
        }
    }
}

fn stored_body(returned: &ReturnedView, checked: &Checked) -> Value {
    let bound: Map<String, Value> = checked
        .bindings
        .iter()
        .map(|b| {
            let mut bound = json!({ "action": b.action, "args": b.args });
            if let Some(list) = &b.list {
                bound["list"] = Value::String(list.clone());
            }
            (b.view_action.clone(), bound)
        })
        .collect();
    let mut body = json!({ "place": returned.place, "view": returned.view, "bindings": bound });
    if let Some(facts) = &checked.facts {
        body["facts"] = json!(facts);
    }
    if let Some(aside) = &checked.aside {
        body["aside"] = json!(aside);
    }
    body
}

/// Where an issue is stored, and what it is made with.
struct Storing<'a> {
    cards: &'a dyn ViewCards,
    question: bool,
    now: i64,
    ids: &'a dyn Ids,
}

/// The issue, and the Needs-you item a real run's View opens, whose id the
/// issue's body keeps so a press can answer it.
fn store_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    worker_id: &str,
    mut body: Value,
    at: &Storing<'_>,
) -> Result<(StoredIssue, Option<String>), Error> {
    let run = tx.routine_sessions().run_of(worker_id)?;
    let run = run.ok_or_else(|| Error::Validation("return_view is for a routine run's sessions".into()))?;
    let surfaces = tx.surfaces().list(Some(&run.routine_id), None)?;
    let surface = surfaces.into_iter().find(|s| s.level == Level::View);
    let surface = surface
        .ok_or_else(|| Error::Validation("this routine makes no view: hand in the result with submit_result".into()))?;
    // The View, its facts and notes came from a run that read outside text.
    if run.trust == Trust::Untrusted {
        body["untrusted"] = Value::Bool(true);
    }
    let trial = run.kind == "trial";
    let id = at.ids.surface_issue_id();
    let item_id = if trial {
        None
    } else {
        let card = ViewCard {
            routine_id: run.routine_id.clone(),
            run_id: run.run_id.clone(),
            surface_id: surface.id.clone(),
            issue_id: id.clone(),
            question: at.question,
            title: text_of(&body["view"]["title"], "Your routine's view"),
            summary: text_of(&body["view"]["summary"], ""),
            by_hand: run.origin == "hand",
        };
        let item_id = at.cards.open_in(tx, out, at.now, &card)?;
        body["itemId"] = Value::String(item_id.clone());
        Some(item_id)
    };
    let issue = StoredIssue {
        id,
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
        created_at: at.now,
        updated_at: at.now,
    };
    tx.surface_issues().put(&issue)?;
    Ok((issue, item_id))
}

fn text_of(value: &Value, otherwise: &str) -> String {
    value.as_str().map(str::trim).filter(|text| !text.is_empty()).unwrap_or(otherwise).to_owned()
}

impl SurfaceTools for ViewIssues {
    fn return_view<'a>(&'a self, worker_id: &'a str, returned: ReturnedView) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let checked = checked(&self.actions, &returned).map_err(|p| Error::Validation(format_problems(&p)))?;
            let body = stored_body(&returned, &checked);
            let bindings = checked.bindings;
            let (worker, now, ids) = (worker_id.to_owned(), self.clock.now_ms(), self.ids.clone());
            let (cards, question) = (self.cards.clone(), returned.place == QUESTION);
            let (issue, item_id) = self
                .store
                .write(move |tx, out| {
                    let at = Storing { cards: cards.as_ref(), question, now, ids: ids.as_ref() };
                    let (issue, item_id) = store_in(tx, out, &worker, body, &at)?;
                    let change = SurfacesIssue {
                        surface_id: issue.surface_id.clone(),
                        issue_id: issue.id.clone(),
                        status: issue.status.as_str().to_owned(),
                        rev: issue.rev,
                    };
                    out.push(SURFACES_ISSUE.name(), &change);
                    Ok((issue, item_id))
                })
                .await?;
            tracing::info!(surface = %issue.surface_id, issue = %issue.id, bound = bindings.len(), "a run returned a view");
            crate::retention::sweep(&self.parts, &issue.surface_id).await;
            let n = bindings.len();
            let line = format!("issue {} · {n} bound action{}", issue.id, if n == 1 { "" } else { "s" });
            match item_id.filter(|_| question) {
                // The run waits for the user, as it does on any question it asks.
                Some(item_id) => Ok(format!("{line}\n\n{}", self.cards.heard(&item_id).await)),
                None => Ok(line),
            }
        })
    }

    fn fill_page<'a>(&'a self, worker_id: &'a str, data: Value) -> BoxFuture<'a, Result<String, Error>> {
        crate::fill::fill_page(&self.parts, &self.fills, worker_id, data)
    }

    fn page_design_read<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Value, Error>> {
        Box::pin(crate::designer::read(self, worker_id))
    }

    fn page_design_propose<'a>(
        &'a self,
        worker_id: &'a str,
        design: Value,
        note: String,
    ) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(crate::designer::propose(self, worker_id, design, note))
    }

    fn app_propose<'a>(&'a self, worker_id: &'a str, app: Value, note: String) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(crate::apps::propose(self, worker_id, app, note))
    }

    fn app_review<'a>(&'a self, worker_id: &'a str, verdict: Value) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(crate::app_checks::verdict(&self.designs, worker_id, verdict))
    }
}
