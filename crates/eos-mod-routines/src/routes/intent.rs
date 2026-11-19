//! `POST /api/routines/intent` (the rules) and `/api/routines/intent/model`
//! (a small model's read): what a sentence typed at Home asks for. Both
//! echo the request's `seq`.

use std::sync::Arc;

use eos_contracts::IntentRequest;
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use crate::engine::Engine;
use crate::intent::{by_model, by_rules};

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let rules_engine = engine.clone();
    let rules = RouteDef::post("/api/routines/intent", move |req: Request| {
        let engine = rules_engine.clone();
        async move {
            let asked: IntentRequest = req.parse()?;
            Ok(Response::json(200, &by_rules(&engine, &asked).await?))
        }
    });
    let model_engine = engine.clone();
    let model = RouteDef::post("/api/routines/intent/model", move |req: Request| {
        let engine = model_engine.clone();
        async move {
            let asked: IntentRequest = req.parse()?;
            Ok(Response::json(200, &by_model(&engine, &asked).await?))
        }
    });
    vec![rules.access(Access::ui_token()), model.access(Access::ui_token())]
}
