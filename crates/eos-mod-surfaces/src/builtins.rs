//! The direct actions surfaces offer themselves: keeping an issue past the
//! retention of old issues (`surface.keep_issue`), and handing a row of a
//! page to the routine's agent (`surface.ask`, a page's Ask).

use std::sync::Arc;

use eos_contracts::ActionClass;
use eos_contracts::{ResultMode, RunInput, SurfaceRunInput, SurfaceRunKind};
use eos_core::routine::{NewRun, RunOrigin, RunStarter, StartError};
use eos_core::store::Store;
use eos_runtime::actions::{ActionCall, ActionDecl, ActionFailure, ActionHandler, ActionScope};
use eos_runtime::router::BoxFuture;
use eos_surface::{Field, Type};
use serde_json::{Value, json};

/// The longest row an Ask hands on, as JSON text.
const ASK_ITEM_MAX: usize = 16 * 1024;

pub(crate) fn declared(store: &Arc<dyn Store>, runs: &Arc<dyn RunStarter>) -> Vec<ActionDecl> {
    vec![
        ActionDecl {
            id: "surface.keep_issue",
            title: "Keep this issue",
            args: Type::Object { fields: vec![Field::required("issue", Type::Text { max: 64 })] },
            class: ActionClass::WriteLocal,
            scope: ActionScope::OwnerRoutine,
            handler: Arc::new(KeepIssue(store.clone())),
        },
        ActionDecl {
            id: crate::page_press::ASK_ACTION,
            title: "Ask about this",
            args: Type::Object {
                fields: vec![
                    Field::required("issue", Type::Text { max: 64 }),
                    Field::required("part", Type::Text { max: 64 }),
                    Field::optional("item", Type::Text { max: ASK_ITEM_MAX }),
                ],
            },
            class: ActionClass::WriteLocal,
            scope: ActionScope::OwnerRoutine,
            handler: Arc::new(Ask { store: store.clone(), runs: runs.clone() }),
        },
    ]
}

/// Starts an `ask` run of the issue's routine on the row it was pressed on.
struct Ask {
    store: Arc<dyn Store>,
    runs: Arc<dyn RunStarter>,
}

impl ActionHandler for Ask {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let issue_id = call.args["issue"].as_str().unwrap_or_default().to_owned();
            let lookup = issue_id.clone();
            let surface = self
                .store
                .read(move |tx| {
                    let Some(issue) = tx.surface_issues().find(&lookup)? else { return Ok(None) };
                    tx.surfaces().find(&issue.surface_id)
                })
                .await
                .map_err(|e| ActionFailure::new("internal", e.to_string()))?;
            let Some(surface) = surface else { return Err(ActionFailure::new("not_found", "That issue is gone")) };
            if call.routine_id.as_deref().is_some_and(|routine| routine != surface.routine_id) {
                return Err(ActionFailure::new("out_of_scope", "That issue belongs to another routine"));
            }
            let item = call.args["item"].as_str().and_then(|text| serde_json::from_str(text).ok());
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
                        kind: SurfaceRunKind::Ask,
                        surface_id: surface.id.clone(),
                        base_version: None,
                        instruction: None,
                        part: call.args["part"].as_str().map(str::to_owned),
                        index: None,
                        issue_id: Some(issue_id),
                        item,
                    }),
                },
                items: Vec::new(),
                origin: RunOrigin::Surface { surface_id: surface.id },
                door: Some("surface".into()),
                confirm_repeat: true,
                // A press is one record: the same record never asks twice.
                client_request_id: Some(call.record_id.clone()),
            };
            match self.runs.start(new).await {
                Ok(made) => Ok(json!({ "runId": made.first().map(|run| run.id.clone()) })),
                Err(error) => Err(ActionFailure::new("refused", start_refusal(&error))),
            }
        })
    }
}

/// Why the routine did not take the ask, as the button shows it.
fn start_refusal(error: &StartError) -> String {
    match error {
        StartError::RoutineState(_) => "The routine is not taking runs now".into(),
        StartError::DayCap => "Today's spending is used up".into(),
        StartError::Halted => "Everything is stopped on this Mac".into(),
        StartError::Unready(unready) => unready.message(),
        _ => "The routine could not start that".into(),
    }
}

struct KeepIssue(Arc<dyn Store>);

impl ActionHandler for KeepIssue {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let id = call.args["issue"].as_str().unwrap_or_default().to_owned();
            let routine = call.routine_id.clone();
            let kept = self
                .0
                .write(move |tx, _| {
                    let Some(mut issue) = tx.surface_issues().find(&id)? else { return Ok(Err("not_found")) };
                    let owner = tx.surfaces().find(&issue.surface_id)?.map(|s| s.routine_id);
                    if routine.is_some() && owner != routine {
                        return Ok(Err("out_of_scope"));
                    }
                    issue.kept = true;
                    tx.surface_issues().put(&issue)?;
                    Ok(Ok(issue.id))
                })
                .await
                .map_err(|e| ActionFailure::new("internal", e.to_string()))?;
            match kept {
                Ok(id) => Ok(json!({ "issueId": id, "kept": true })),
                Err("not_found") => Err(ActionFailure::new("not_found", "That issue is gone")),
                Err(kind) => Err(ActionFailure::new(kind, "That issue belongs to another routine")),
            }
        })
    }
}
