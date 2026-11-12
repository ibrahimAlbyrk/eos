//! An orchestrator arming, amending and stopping a loop (`manager/routes/loops.ts`,
//! `core/src/use-cases/amendLoop.ts`, `stopLoop.ts`). The orchestrator is the
//! path's id, and it acts only on its own loops and its own workers'.

use std::sync::Arc;

use eos_contracts::stream::topics::LOOP_CHANGE;
use eos_contracts::{DynamicLoopRequest, DynamicLoopRequestOp, DynamicLoopResponse, LoopStatus, LoopStrategy};
use eos_core::store::{ConfigSource, LoopAmend, Store, Tx};
use eos_core::{Error, Ids};
use eos_domain::WorkerLoop;
use eos_domain::loops::can_transition;
use eos_domain::loops::lint::lint_goal_criteria;
use eos_domain::worker::{Ownership, ownership};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::loops::{AttachLoop, attach_loop};
use serde_json::json;

#[derive(Clone)]
pub(crate) struct Deps {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) clock: Arc<dyn eos_core::Clock>,
}

fn disabled() -> Error {
    Error::Validation("dynamic loop is disabled — set config.loop.enabled".into())
}

fn answer(loop_id: String, status: LoopStatus, warnings: Vec<String>) -> DynamicLoopResponse {
    DynamicLoopResponse { loop_id, status, warnings: (!warnings.is_empty()).then_some(warnings) }
}

/// The loop by id, or the target's (else the caller's) active one; refused
/// unless the caller owns its worker.
fn resolve(tx: &dyn Tx, caller: &str, body: &DynamicLoopRequest) -> Result<WorkerLoop, Error> {
    let found = match &body.loop_id {
        Some(id) => tx.loops().find(id)?,
        None => tx.loops().find_active_by_worker(body.target.as_deref().unwrap_or(caller))?,
    };
    let wanted = body.loop_id.as_deref().or(body.target.as_deref()).unwrap_or(caller);
    let found = found.ok_or_else(|| Error::not_found("loop", wanted))?;
    owned_by(tx, caller, &found.worker_id)?;
    Ok(found)
}

fn owned_by(tx: &dyn Tx, caller: &str, worker_id: &str) -> Result<(), Error> {
    let target = tx.workers().find(worker_id)?;
    match ownership(target.as_ref(), worker_id, caller, true) {
        Ownership::Owned => Ok(()),
        Ownership::Missing => Err(Error::not_found("worker", worker_id)),
        Ownership::NotManaged => Err(Error::PermissionDenied(format!("worker {worker_id} is not managed by {caller}"))),
    }
}

/// Renegotiates an active loop's goal in place: the fields given replace,
/// the others stay. A new goal starts a fresh no-progress window; a loop
/// waiting for an answer keeps waiting.
fn amend(tx: &dyn Tx, now: i64, caller: &str, body: &DynamicLoopRequest) -> Result<DynamicLoopResponse, Error> {
    let orchestrator = tx.workers().find(caller)?.ok_or_else(|| Error::not_found("worker", caller))?;
    if !orchestrator.is_orchestrator {
        return Err(Error::PermissionDenied(format!("worker {caller} is not an orchestrator")));
    }
    let active = resolve(tx, caller, body)?;
    if active.status != LoopStatus::Active {
        let status = serde_json::to_value(active.status).ok().and_then(|s| s.as_str().map(str::to_owned));
        return Err(Error::Conflict(format!(
            "loop {} is {}, not active — cannot amend",
            active.id,
            status.unwrap_or_default()
        )));
    }
    let mut warnings = Vec::new();
    if body.goal.is_some() || body.strategy.is_some() {
        let goal = match &body.goal {
            Some(goal) => goal.clone(),
            None => {
                active.goal_spec().ok_or_else(|| Error::Validation("the loop's goal is of an older shape".into()))?
            }
        };
        warnings = lint_goal_criteria(body.strategy.unwrap_or(active.strategy), &goal).map_err(Error::Validation)?;
    }
    let patch = LoopAmend { goal: body.goal.clone(), strategy: body.strategy, max_attempts: body.limit };
    tx.loops().amend(&active.id, &patch, now)?;
    if body.goal.is_some() {
        tx.loops().reset_progress(&active.id, now)?;
    }
    Ok(answer(active.id, LoopStatus::Active, warnings))
}

/// Stops the loop; one already ended answers with how it ended.
fn stop(tx: &dyn Tx, now: i64, caller: &str, body: &DynamicLoopRequest) -> Result<(WorkerLoop, LoopStatus), Error> {
    let found = resolve(tx, caller, body)?;
    if found.status != LoopStatus::Stopped && can_transition(found.status, LoopStatus::Stopped) {
        tx.loops().set_status(&found.id, LoopStatus::Stopped, now)?;
        return Ok((found, LoopStatus::Stopped));
    }
    let status = found.status;
    Ok((found, status))
}

/// The configured strategy (`config.loop.strategy`), when it names one.
fn configured_strategy(name: &str) -> Option<LoopStrategy> {
    serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()
}

fn arm_or_amend(deps: Deps) -> RouteDef {
    RouteDef::post("/orchestrators/{id}/loop", move |req: Request| {
        let deps = deps.clone();
        async move {
            let body: DynamicLoopRequest = req.parse()?;
            let caller = req.param("id").unwrap_or_default().to_owned();
            let config = deps.config.current();
            let enabled = config.r#loop.enabled;
            let now = deps.clock.now_ms();
            if body.op == DynamicLoopRequestOp::Amend {
                if !enabled {
                    return Err(disabled().into());
                }
                let response = deps
                    .store
                    .write(move |tx, out| {
                        let response = amend(tx, now, &caller, &body)?;
                        if let Some(amended) = tx.loops().find(&response.loop_id)? {
                            out.push(LOOP_CHANGE, &json!({"workerId": amended.worker_id, "status": "active"}));
                        }
                        Ok(response)
                    })
                    .await?;
                return Ok(Response::json(200, &response));
            }
            let Some(goal) = body.goal.clone() else {
                return Err(ApiError::Validation("goal required to attach a loop".into()));
            };
            if !enabled {
                return Err(disabled().into());
            }
            // An omitted limit takes the configured one; an explicit one (no cap included) wins.
            let attach = AttachLoop {
                caller_id: caller.clone(),
                target: body.target.clone(),
                goal,
                strategy: body.strategy.or_else(|| configured_strategy(&config.r#loop.strategy)),
                limit: body.limit.unwrap_or(config.r#loop.max_attempts),
            };
            let ids = deps.ids.clone();
            let attached = deps
                .store
                .write(move |tx, out| {
                    let attached = attach_loop(tx, ids.as_ref(), now, &attach)?;
                    let worker = attach.target.as_deref().unwrap_or(&attach.caller_id);
                    out.push(LOOP_CHANGE, &json!({"workerId": worker, "status": "active"}));
                    Ok(attached)
                })
                .await?;
            Ok(Response::json(200, &answer(attached.id, LoopStatus::Active, attached.warnings)))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn stop_route(deps: Deps) -> RouteDef {
    RouteDef::post("/orchestrators/{id}/loop/stop", move |req: Request| {
        let deps = deps.clone();
        async move {
            let body: DynamicLoopRequest = req.parse()?;
            let caller = req.param("id").unwrap_or_default().to_owned();
            let now = deps.clock.now_ms();
            let (found, status) = deps
                .store
                .write(move |tx, out| {
                    let (found, status) = stop(tx, now, &caller, &body)?;
                    out.push(LOOP_CHANGE, &json!({"workerId": found.worker_id, "status": status}));
                    Ok((found, status))
                })
                .await?;
            Ok(Response::json(200, &answer(found.id, status, Vec::new())))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

pub(crate) fn all(deps: &Deps) -> Vec<RouteDef> {
    vec![arm_or_amend(deps.clone()), stop_route(deps.clone())]
}
