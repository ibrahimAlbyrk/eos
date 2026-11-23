//! The direct actions surfaces offer themselves: keeping an issue past the
//! retention of old issues (`surface.keep_issue`).

use std::sync::Arc;

use eos_contracts::ActionClass;
use eos_core::store::Store;
use eos_runtime::actions::{ActionCall, ActionDecl, ActionFailure, ActionHandler, ActionScope};
use eos_runtime::router::BoxFuture;
use eos_surface::{Field, Type};
use serde_json::{Value, json};

pub(crate) fn declared(store: &Arc<dyn Store>) -> Vec<ActionDecl> {
    vec![ActionDecl {
        id: "surface.keep_issue",
        title: "Keep this issue",
        args: Type::Object { fields: vec![Field::required("issue", Type::Text { max: 64 })] },
        class: ActionClass::WriteLocal,
        scope: ActionScope::OwnerRoutine,
        handler: Arc::new(KeepIssue(store.clone())),
    }]
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
