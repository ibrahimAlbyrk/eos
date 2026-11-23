//! What a surface's buttons and live parts may do with Needs you, through
//! the direct-action registry: answer an item with one of its kind's
//! choices (`needs_you.answer`), put one aside (`needs_you.later`), and read
//! what waits (`needs_you.summary`: counts and kinds, and titles only of the
//! asking routine's own items). An item of another routine is out of reach
//! of a routine's surface.

use std::collections::BTreeMap;
use std::sync::Arc;

use eos_contracts::{ActionClass, InboxAnswer};
use eos_core::store::StoredItem;
use eos_domain::inbox::ItemState;
use eos_runtime::actions::{
    ActionCall, ActionDecl, ActionFailure, ActionHandler, ActionScope, QueryCall, QueryDecl, QueryHandler, no_args,
};
use eos_runtime::router::BoxFuture;
use eos_surface::{Field, Type};
use serde_json::{Value, json};

use crate::Shared;

fn item_field() -> Field {
    Field::required("item", Type::Text { max: 64 })
}

pub(crate) fn declared(shared: &Arc<Shared>) -> Vec<ActionDecl> {
    vec![
        ActionDecl {
            id: "needs_you.answer",
            title: "Answer",
            args: Type::Object {
                fields: vec![
                    item_field(),
                    Field::required("rev", Type::Int),
                    Field::required("choice", Type::Text { max: 40 }),
                ],
            },
            class: ActionClass::WriteLocal,
            scope: ActionScope::OwnerRoutine,
            handler: Arc::new(Answer(shared.clone())),
        },
        ActionDecl {
            id: "needs_you.later",
            title: "Later",
            args: Type::Object { fields: vec![item_field(), Field::optional("until", Type::Int)] },
            class: ActionClass::WriteLocal,
            scope: ActionScope::OwnerRoutine,
            handler: Arc::new(Later(shared.clone())),
        },
    ]
}

pub(crate) fn queries(shared: &Arc<Shared>) -> Vec<QueryDecl> {
    vec![QueryDecl {
        id: "needs_you.summary",
        title: "What waits for you",
        args: no_args(),
        scope: ActionScope::Any,
        handler: Arc::new(Summary(shared.clone())),
    }]
}

/// The item the call names, if the calling routine may touch it.
async fn reachable(shared: &Shared, call: &ActionCall) -> Result<StoredItem, ActionFailure> {
    let id = call.args["item"].as_str().unwrap_or_default().to_owned();
    let found = shared.store.read(move |tx| tx.inbox_items().find(&id)).await;
    let item = found.map_err(|e| ActionFailure::new("internal", e.to_string()))?;
    let item = item.ok_or_else(|| ActionFailure::new("not_found", "That item is gone"))?;
    if call.routine_id.is_some() && item.routine_id != call.routine_id {
        return Err(ActionFailure::new("out_of_scope", "That item belongs to another routine"));
    }
    Ok(item)
}

fn by(origin: &str) -> &'static str {
    if origin == "phone" { "phone" } else { "dashboard" }
}

/// Why an answer did not land, as the button shows it.
fn not_landed(error: eos_inbox::Error) -> ActionFailure {
    let reason = match &error {
        eos_inbox::Error::AlreadyAnswered { .. } => "Already answered",
        eos_inbox::Error::Changed { .. } => "It changed since you saw it",
        eos_inbox::Error::Core(_) => return ActionFailure::new("internal", error.to_string()),
        _ => "Not answered",
    };
    ActionFailure::new("refused", reason)
}

struct Answer(Arc<Shared>);

impl ActionHandler for Answer {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let item = reachable(&self.0, &call).await?;
            let answer: InboxAnswer =
                serde_json::from_value(json!({"kind": item.kind.as_str(), "choice": call.args["choice"]}))
                    .map_err(|_| ActionFailure::new("invalid", "That is not an answer this item takes"))?;
            let rev = call.args["rev"].as_i64().unwrap_or_default();
            let done = self.0.items.answer(&item.id, rev, &answer, by(&call.origin)).await.map_err(not_landed)?;
            Ok(json!({"itemId": done.id, "state": done.state.as_str()}))
        })
    }
}

struct Later(Arc<Shared>);

impl ActionHandler for Later {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let item = reachable(&self.0, &call).await?;
            let done = self.0.items.later(&item.id, call.args["until"].as_i64()).await.map_err(not_landed)?;
            Ok(json!({"itemId": done.id, "state": done.state.as_str()}))
        })
    }
}

struct Summary(Arc<Shared>);

impl QueryHandler for Summary {
    fn read(&self, call: QueryCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let routine = call.routine_id.clone();
            let read = self
                .0
                .store
                .read(move |tx| {
                    let own = match &routine {
                        Some(id) => tx.inbox_items().waiting_of_routine(id)?,
                        None => Vec::new(),
                    };
                    Ok((tx.inbox_items().counts()?, own))
                })
                .await;
            let (counts, own) = read.map_err(|e| ActionFailure::new("internal", e.to_string()))?;
            let (mut open, mut later, mut kinds) = (0, 0, BTreeMap::<&str, i64>::new());
            for row in &counts {
                match row.state {
                    ItemState::Open => open += row.count,
                    ItemState::Later => later += row.count,
                    _ => continue,
                }
                *kinds.entry(row.kind.as_str()).or_default() += row.count;
            }
            let items: Vec<Value> =
                own.iter().map(|i| json!({"id": i.id, "kind": i.kind.as_str(), "title": i.title})).collect();
            Ok(json!({"count": open, "open": open, "later": later, "kinds": kinds, "items": items}))
        })
    }
}
