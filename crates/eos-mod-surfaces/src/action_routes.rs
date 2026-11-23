//! `GET /api/actions` (the registry), `POST /api/actions/run` (a press,
//! through the dispatcher) and `GET /api/actions/records/:id` (one record).

use std::sync::Arc;

use eos_contracts::{ActionAnswer, ActionDefRow, ActionList, ActionRunRequest};
use eos_core::Error;
use eos_core::surface::DirectActions;
use eos_runtime::access::{Access, Caller, Tier};
use eos_runtime::actions::Actions;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use crate::SurfacesParts;
use crate::dispatch::Dispatcher;
use crate::records::wire;
use crate::routes::param;

fn origin(caller: &Caller) -> &'static str {
    match caller {
        Caller::Phone { .. } => "phone",
        _ => "dashboard",
    }
}

pub(crate) fn all(parts: &Arc<SurfacesParts>, actions: &Actions, dispatcher: &Arc<Dispatcher>) -> Vec<RouteDef> {
    let registry = actions.clone();
    let list = RouteDef::get("/api/actions", move |_req: Request| {
        let registry = registry.clone();
        async move {
            let rows = registry
                .registry()
                .actions()
                .map(|a| ActionDefRow {
                    id: a.id.to_owned(),
                    title: a.title.to_owned(),
                    class: a.class,
                    scope: a.scope.as_str().to_owned(),
                    args: a.args.to_json(),
                })
                .collect();
            Ok::<_, eos_runtime::http::ApiError>(Response::json(200, &ActionList { actions: rows }))
        }
    })
    .access(Access::open().phone(Tier::Read));

    let dispatcher = dispatcher.clone();
    let run = RouteDef::post("/api/actions/run", move |req: Request| {
        let dispatcher = dispatcher.clone();
        async move {
            let asked: ActionRunRequest = req.parse()?;
            let answer = dispatcher.run(asked, origin(&req.caller)).await?;
            let status = if matches!(answer, ActionAnswer::Confirm { .. }) { 202 } else { 200 };
            Ok(Response::json(status, &answer))
        }
    })
    .access(Access::ui_token().phone_user(Tier::High));

    let at = parts.clone();
    let record = RouteDef::get("/api/actions/records/{id}", move |req: Request| {
        let (at, id) = (at.clone(), param(&req, "id"));
        async move {
            let found = at
                .store
                .read(move |tx| tx.action_log().find(&id)?.ok_or_else(|| Error::not_found("action record", &id)));
            Ok(Response::json(200, &wire(&found.await?)))
        }
    })
    .access(Access::open().phone(Tier::Read));
    vec![list, run, record]
}
