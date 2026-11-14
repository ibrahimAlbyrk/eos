use std::sync::Arc;

use eos_contracts::{
    PendingDecisionRequest, PendingDecisionRequestDecision, PendingPermissionRow, PolicyBehavior, PolicyDecideRequest,
    PolicyRuleResponse,
};
use eos_core::policy::ToolCall;
use eos_core::store::Store;
use eos_policy::{Answer, PolicyGateway};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

pub(crate) fn all(gateway: Arc<PolicyGateway>, store: Arc<dyn Store>) -> Vec<RouteDef> {
    vec![decide(gateway.clone()), pending(store), decision(gateway.clone()), rule(gateway)]
}

/// Local callers only: the request stays open while an ask waits.
fn decide(gateway: Arc<PolicyGateway>) -> RouteDef {
    RouteDef::post("/policy/decide", move |req: Request| {
        let gateway = gateway.clone();
        async move {
            let body: PolicyDecideRequest = req.parse()?;
            let decision = gateway
                .decide(ToolCall {
                    worker_id: body.worker_id,
                    tool_name: body.tool_name,
                    input: body.input,
                    tool_use_id: body.tool_use_id.flatten(),
                    agent_id: body.agent_id.flatten(),
                    full_surface: false,
                })
                .await?;
            Ok(Response::json(200, &decision))
        }
    })
    .access(Access::open().local_only())
}

/// The open asks, oldest first. `?parentId=` keeps the asks of that
/// session's direct children: what `list_pending_permissions` shows it.
fn pending(store: Arc<dyn Store>) -> RouteDef {
    RouteDef::get("/pending", move |req: Request| {
        let store = store.clone();
        async move {
            let parent = req.query().get("parentId").filter(|id| !id.is_empty()).map(|id| id.into_owned());
            let rows = store
                .read(move |tx| {
                    let mut rows = tx.pending().list_unresolved()?;
                    if let Some(parent) = parent {
                        let children = tx.workers().find_children_ids(&parent)?;
                        rows.retain(|row| children.contains(&row.worker_id));
                    }
                    Ok(rows)
                })
                .await?;
            let rows: Vec<PendingPermissionRow> = rows.iter().map(|row| row.to_list_row()).collect();
            Ok(Response::json(200, &rows))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn decision(gateway: Arc<PolicyGateway>) -> RouteDef {
    RouteDef::post("/pending/{id}/decision", move |req: Request| {
        let gateway = gateway.clone();
        async move {
            let body: PendingDecisionRequest = req.parse()?;
            let id = req.param("id").unwrap_or_default();
            let answer = match body.decision {
                PendingDecisionRequestDecision::Allow => Answer::Allow { updated_input: body.updated_input },
                PendingDecisionRequestDecision::Deny => Answer::Deny { reason: body.reason },
            };
            gateway.resolve(id, answer).await?;
            Ok(Response::json(200, &json!({ "ok": true })))
        }
    })
    .access(Access::open().phone(Tier::High))
}

fn behavior(name: &str) -> Option<PolicyBehavior> {
    match name {
        "allow" => Some(PolicyBehavior::Allow),
        "deny" => Some(PolicyBehavior::Deny),
        "ask" => Some(PolicyBehavior::Ask),
        "rewrite" => Some(PolicyBehavior::Rewrite),
        _ => None,
    }
}

/// "Always allow": one rule per tool; a second save for the same tool
/// answers `existed` and changes nothing.
fn rule(gateway: Arc<PolicyGateway>) -> RouteDef {
    RouteDef::post("/api/policy/rule", move |req: Request| {
        let gateway = gateway.clone();
        async move {
            let body: Value = req.json()?;
            let Some(tool) = body.get("tool").and_then(Value::as_str).filter(|tool| !tool.is_empty()) else {
                return Err(ApiError::status_with(400, "tool must be a non-empty string"));
            };
            let Some(action) = body.get("behavior").and_then(Value::as_str).and_then(behavior) else {
                return Err(ApiError::status_with(400, "behavior must be one of allow, deny, ask, rewrite"));
            };
            // A file that cannot be read or written answers 500 with the cause.
            let added = gateway.save_rule(tool, action).map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(Response::json(200, &PolicyRuleResponse { ok: true, existed: (!added).then_some(true) }))
        }
    })
    .access(Access::open().phone(Tier::High))
}
