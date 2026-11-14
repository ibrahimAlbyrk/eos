//! Presenting and reading visual answers.
//!
//! | Route | |
//! |---|---|
//! | `POST /api/genui/views` | `present`: an orchestrator or a focused session |
//! | `POST /api/genui/apps` | `present_app`: the same callers |
//! | `GET /api/genui/views/{id}` | the stored record (a side-panel tab after a reload) |
//! | `GET /api/genui/views/{id}/state` | the view's UI state |
//! | `PUT /api/genui/views/{id}/state` | the dashboard's; announces `genui:change` |

use std::sync::Arc;

use eos_contracts::{
    CreateAppRequest, CreateAppResponse, CreateViewRequest, CreateViewResponse, GenuiChange, GenuiRejection, Num,
    PutViewStateRequest, ViewId, ViewProblem, ViewState, ViewStateResponse, ViewStats, ViewStatsCollectionsItem,
};
use eos_core::genui::PresentRefusal;
use eos_core::store::Store;
use eos_core::{Clock, Error};
use eos_genui::catalog::GENUI_LIMITS;
use eos_runtime::access::Access;
use eos_runtime::bus::Announce;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;
use serde_json::Value;

use crate::GENUI_CHANGE;
use crate::present::Presenter;

pub(crate) fn all(presenter: Presenter) -> Vec<RouteDef> {
    let (store, clock) = (presenter.store.clone(), presenter.clock.clone());
    vec![
        present_view(presenter.clone()),
        present_app(presenter),
        view(store.clone()),
        state(store.clone()),
        put_state(store, clock),
    ]
}

/// Today's answer for a path no route matches.
#[derive(Serialize)]
struct NoRoute<'a> {
    error: &'static str,
    path: &'a str,
}

/// The `{id}` of the path. Today's routes exist only for `v_` + 12 letters
/// and digits: anything else is no route at all.
fn view_id(req: &Request) -> Result<String, Response> {
    let id = req.param("id").unwrap_or_default();
    match eos_genui::ViewId::parse(id) {
        Ok(_) => Ok(id.to_owned()),
        Err(_) => Err(Response::json(404, &NoRoute { error: "not found", path: req.path() })),
    }
}

fn whole(n: usize) -> Num {
    #[allow(clippy::cast_precision_loss)]
    Num(n as f64)
}

fn wire_problems(problems: Vec<eos_genui::ViewProblem>) -> Vec<ViewProblem> {
    problems.into_iter().map(|p| ViewProblem { path: p.path, message: p.message }).collect()
}

fn wire_stats(stats: eos_genui::ViewStats) -> ViewStats {
    ViewStats {
        ui_bytes: whole(stats.ui_bytes),
        data_bytes: whole(stats.data_bytes),
        elements: whole(stats.elements),
        depth: whole(stats.depth),
        components: stats.components,
        collections: stats
            .collections
            .into_iter()
            .map(|c| ViewStatsCollectionsItem { name: c.name, count: whole(c.count), r#type: c.kind })
            .collect(),
        images: whole(stats.images),
        sites: whole(stats.sites),
        maps: whole(stats.maps),
        primary_actions: whole(stats.primary_actions),
    }
}

/// A refusal as the route answers it: the caller's role and the user's
/// switches are 403s, a failed check is a 400 with every problem.
fn refused(refusal: PresentRefusal) -> Result<Response, ApiError> {
    match refusal {
        PresentRefusal::Rejected(problems) => {
            let error = eos_genui::format_problems(&problems);
            Ok(Response::json(400, &GenuiRejection { error, problems: wire_problems(problems) }))
        }
        PresentRefusal::Failed(e) => Err(e.into()),
        refusal @ (PresentRefusal::NotPresenter | PresentRefusal::SwitchedOff(_)) => {
            Err(ApiError::PermissionDenied(refusal.to_string()))
        }
    }
}

/// The agent the request declares itself to be, when it may present.
async fn presenter(presenter: &Presenter, req: &Request) -> Result<String, ApiError> {
    let agent = req.headers.get("x-eos-agent-id").map(str::to_owned);
    presenter
        .presenter_of(agent)
        .await?
        .ok_or_else(|| ApiError::PermissionDenied(PresentRefusal::NotPresenter.to_string()))
}

fn present_view(presenter: Presenter) -> RouteDef {
    RouteDef::post("/api/genui/views", move |req: Request| {
        let presenter = presenter.clone();
        async move {
            let worker_id = self::presenter(&presenter, &req).await?;
            let body: CreateViewRequest = req.parse()?;
            match presenter.view(&worker_id, &body.input.unwrap_or(Value::Null)).await {
                Ok(done) => Ok(Response::json(
                    201,
                    &CreateViewResponse {
                        view_id: ViewId(done.view_id),
                        warnings: wire_problems(done.warnings),
                        stats: wire_stats(done.stats),
                    },
                )),
                Err(refusal) => refused(refusal),
            }
        }
    })
    .access(Access::open())
}

fn present_app(presenter: Presenter) -> RouteDef {
    RouteDef::post("/api/genui/apps", move |req: Request| {
        let presenter = presenter.clone();
        async move {
            let worker_id = self::presenter(&presenter, &req).await?;
            let body: CreateAppRequest = req.parse()?;
            match presenter.app(&worker_id, &body.input.unwrap_or(Value::Null)).await {
                Ok(done) => Ok(Response::json(
                    201,
                    &CreateAppResponse { view_id: ViewId(done.view_id), warnings: wire_problems(done.warnings) },
                )),
                Err(refusal) => refused(refusal),
            }
        }
    })
    .access(Access::open())
}

fn view(store: Arc<dyn Store>) -> RouteDef {
    RouteDef::get("/api/genui/views/{id}", move |req: Request| {
        let store = store.clone();
        async move {
            let id = match view_id(&req) {
                Ok(id) => id,
                Err(no_route) => return Ok(no_route),
            };
            let found = store.read(move |tx| tx.genui_views().get(&id).map(|view| (id, view))).await?;
            match found {
                (_, Some(view)) => Ok(Response::json(200, &view)),
                (id, None) => Err(Error::not_found("view", id).into()),
            }
        }
    })
    .access(Access::open())
}

fn state(store: Arc<dyn Store>) -> RouteDef {
    RouteDef::get("/api/genui/views/{id}/state", move |req: Request| {
        let store = store.clone();
        async move {
            let id = match view_id(&req) {
                Ok(id) => id,
                Err(no_route) => return Ok(no_route),
            };
            let (id, stored) = store
                .read(move |tx| {
                    let views = tx.genui_views();
                    if views.get(&id)?.is_none() {
                        return Err(Error::not_found("view", id));
                    }
                    views.get_state(&id).map(|stored| (id, stored))
                })
                .await?;
            #[allow(clippy::cast_precision_loss)]
            let updated_at = stored.as_ref().map(|s| Num(s.updated_at as f64));
            let state = stored.map(|s| s.state).unwrap_or_default();
            Ok(Response::json(200, &ViewStateResponse { view_id: ViewId(id), state, updated_at }))
        }
    })
    .access(Access::open())
}

/// Agents read a view's state but never set it: what the user picked is the user's.
fn put_state(store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> RouteDef {
    RouteDef::put("/api/genui/views/{id}/state", move |req: Request| {
        let (store, clock) = (store.clone(), clock.clone());
        async move {
            let id = match view_id(&req) {
                Ok(id) => id,
                Err(no_route) => return Ok(no_route),
            };
            let body: PutViewStateRequest = req.parse()?;
            let saved = save_state(&store, id, body.state, clock.now_ms()).await?;
            Ok(Response::json(200, &saved))
        }
    })
    .access(Access::ui_token())
    // The state cap plus room for the JSON around it.
    .max_body(GENUI_LIMITS.state_bytes + 4096)
}

async fn save_state(store: &Arc<dyn Store>, id: String, state: ViewState, at: i64) -> Result<ViewStateResponse, Error> {
    store
        .write(move |tx, out| {
            let views = tx.genui_views();
            if views.get(&id)?.is_none() {
                return Err(Error::not_found("view", id));
            }
            views.put_state(&id, &state, at)?;
            let change = GenuiChange { view_id: ViewId(id), state };
            out.announce(&GENUI_CHANGE, &change);
            #[allow(clippy::cast_precision_loss)]
            let updated_at = Some(Num(at as f64));
            Ok(ViewStateResponse { view_id: change.view_id, state: change.state, updated_at })
        })
        .await
}
