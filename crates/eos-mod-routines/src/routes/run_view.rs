//! One run for the run view (01 §8): the run with its input, agents,
//! verdict, usual cost and timeline; its result; its timeline alone.

use std::sync::Arc;

use eos_contracts::{CheckVerdict, Num, RunAgent, RunDetail, RunEvent, RunInput, RunResultBody, UsualCost};
use eos_core::Error;
use eos_core::store::{StoredRun, StoredRunEvent, StoredRunResult, Tx};
use eos_domain::worker::state_name;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::Value;

use super::estimate::usual_of;
use super::{param, readable, run_summaries};
use crate::engine::Engine;

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let viewing = engine.clone();
    let detail = RouteDef::get("/api/runs/{id}", move |req: Request| {
        let engine = viewing.clone();
        async move {
            let id = param(&req, "id");
            let line = |run_id: &str| Engine::locked(&engine.progress).get(run_id).cloned();
            let last_activity = line(&id);
            let detail = engine.store.read(move |tx| run_detail(tx, &id, last_activity)).await?;
            Ok(Response::json(200, &detail))
        }
    });
    let store = engine.store.clone();
    let result = RouteDef::get("/api/runs/{id}/result", move |req: Request| {
        let store = store.clone();
        async move {
            let id = param(&req, "id");
            let result = store
                .read(move |tx| {
                    find(tx, &id)?;
                    let last = tx.run_results().by_run(&id)?.pop();
                    last.map(result_body).ok_or_else(|| Error::not_found("run result", id))
                })
                .await?;
            Ok(Response::json(200, &result))
        }
    });
    let store = engine.store.clone();
    let events = RouteDef::get("/api/runs/{id}/events", move |req: Request| {
        let store = store.clone();
        async move {
            let id = param(&req, "id");
            let events = store
                .read(move |tx| {
                    find(tx, &id)?;
                    Ok(tx.runs().events(&id)?.into_iter().map(event).collect::<Vec<_>>())
                })
                .await?;
            Ok(Response::json(200, &events))
        }
    });
    // Routine text and results: the user's dashboard only, the phone reads.
    let read = Access::ui_token().phone_user(Tier::Read);
    vec![detail.access(read), result.access(read), events.access(Access::ui_token())]
}

fn find(tx: &dyn Tx, id: &str) -> Result<StoredRun, Error> {
    tx.runs().find(id)?.ok_or_else(|| Error::not_found("run", id))
}

fn run_detail(tx: &dyn Tx, id: &str, last_activity: Option<String>) -> Result<RunDetail, Error> {
    let run = find(tx, id)?;
    let input: RunInput =
        serde_json::from_str(&run.input).map_err(|_| Error::storage(format!("run {id} has no input")))?;
    let mut agents = Vec::new();
    for session in tx.routine_sessions().by_run(id)? {
        let Some(worker) = tx.workers().find(&session.worker_id)? else { continue };
        let leads = run.lead_id.as_deref() == Some(worker.id.as_str());
        agents.push(RunAgent {
            worker_id: worker.id.clone(),
            agent_key: session.agent_key,
            name: worker.name.clone(),
            role: session.role,
            model: worker.model.clone(),
            effort: worker.effort.clone(),
            state: state_name(worker.state).to_owned(),
            cost_usd: Num(worker.usage.cost_usd),
            started_at: worker.started_at,
            ended_at: worker.ended_at,
            last_activity: last_activity.clone().filter(|_| leads),
        });
    }
    let verdict = tx.run_results().by_run(id)?.into_iter().rev().find_map(|result| verdict(&result));
    let version = match &run.version_id {
        Some(version_id) => tx.routine_versions().find(&run.routine_id, version_id)?,
        None => None,
    };
    let blueprint = version.as_ref().map(readable).transpose()?.flatten();
    let usual = match &blueprint {
        Some(blueprint) => usual_of(tx, blueprint, &run)?.map(|usual| UsualCost { usd: Num(usual.usd), ms: usual.ms }),
        None => None,
    };
    let events = tx.runs().events(id)?.into_iter().map(event).collect();
    let summary = run_summaries(tx, [&run])?.remove(0);
    Ok(RunDetail { run: summary, input, attempt: run.attempt, agents, verdict, usual, events })
}

fn verdict(result: &StoredRunResult) -> Option<CheckVerdict> {
    result.verdict.as_deref().and_then(|text| serde_json::from_str(text).ok())
}

fn result_body(result: StoredRunResult) -> RunResultBody {
    let files: Vec<Value> =
        result.files.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
    RunResultBody {
        verdict: verdict(&result),
        run_id: result.run_id,
        attempt: result.attempt,
        kind: result.kind,
        headline: result.headline,
        body: serde_json::from_str(&result.body).unwrap_or(Value::Null),
        files,
        created_at: result.created_at,
    }
}

fn event(event: StoredRunEvent) -> RunEvent {
    RunEvent {
        id: event.id,
        at: event.at,
        kind: event.kind,
        data: event.data.as_deref().and_then(|text| serde_json::from_str(text).ok()),
    }
}
