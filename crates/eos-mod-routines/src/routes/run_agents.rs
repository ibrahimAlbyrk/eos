//! `GET /api/run-agents/:workerId`: the run a worker works for, so a job, a
//! banner or an ask of one opens the run view instead of Agents. It carries
//! no text of the user's, so anyone local may ask.

use std::sync::Arc;

use eos_contracts::RunAgentLookup;
use eos_core::Error;
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::param;
use crate::engine::Engine;

pub(crate) fn route(engine: &Arc<Engine>) -> RouteDef {
    let store = engine.store.clone();
    RouteDef::get("/api/run-agents/{workerId}", move |req: Request| {
        let store = store.clone();
        async move {
            let worker = param(&req, "workerId");
            let found = store
                .read(move |tx| {
                    let session = tx.routine_sessions().find(&worker)?;
                    let found = session.and_then(|session| {
                        let run_id = session.run_id?;
                        Some(RunAgentLookup { run_id, routine_id: session.routine_id, role: session.role })
                    });
                    found.ok_or_else(|| Error::not_found("run agent", worker))
                })
                .await?;
            Ok(Response::json(200, &found))
        }
    })
    .access(Access::open())
}
