//! The page routes. Agents read and write pages too, so only delete needs the
//! user's window.

use std::sync::Arc;

use eos_contracts::{Page, PageCreateRequest, PageEditRequest, PageId, PageSummary, PageUpdateRequest};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;

use crate::Error;
use crate::desk::{PageCaller, PageDesk};

#[derive(Serialize)]
struct PageBody<'a> {
    page: &'a Page,
}

#[derive(Serialize)]
struct PagesBody {
    pages: Vec<PageSummary>,
}

/// The answer to a save over a stale revision: why, and the page as it is now.
#[derive(Serialize)]
struct StaleBody<'a> {
    error: String,
    page: &'a Page,
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

fn page(status: u16, page: &Page) -> Response {
    Response::json(status, &PageBody { page })
}

fn failed(error: Error) -> Result<Response, ApiError> {
    match error {
        Error::Stale(current) => {
            let error = Error::Stale(current.clone()).to_string();
            Ok(Response::json(409, &StaleBody { error, page: &current }))
        }
        Error::Core(e) => Err(e.into()),
    }
}

async fn caller(desk: &PageDesk, req: &Request) -> Result<PageCaller, ApiError> {
    Ok(desk.caller(req.headers.get("x-eos-agent-id")).await?)
}

/// The `{id}` of the path, refused before the body is read when it is not a
/// page id.
fn id(req: &Request) -> Result<&str, ApiError> {
    let id = req.param("id").unwrap_or_default();
    eos_contracts::check(&PageId(id.to_owned()))?;
    Ok(id)
}

pub(crate) fn all(desk: &Arc<PageDesk>) -> Vec<RouteDef> {
    let list = {
        let desk = desk.clone();
        // `?project=<folder>` one project's pages, `?all=1` every page; with
        // neither, an agent gets its own project's and the window everything.
        // `?q=` filters by text.
        RouteDef::get("/api/pages", move |req: Request| {
            let desk = desk.clone();
            async move {
                let caller = caller(&desk, &req).await?;
                let query = req.query();
                let all = query.get("all").as_deref() == Some("1");
                let pages = desk.list(&caller, query.get("project").as_deref(), all, query.get("q").as_deref());
                Ok(Response::json(200, &PagesBody { pages }))
            }
        })
    };
    let read = {
        let desk = desk.clone();
        RouteDef::get("/api/pages/{id}", move |req: Request| {
            let desk = desk.clone();
            async move { desk.read(id(&req)?).map_or_else(failed, |found| Ok(page(200, &found))) }
        })
    };
    let create = {
        let desk = desk.clone();
        RouteDef::post("/api/pages", move |req: Request| {
            let desk = desk.clone();
            async move {
                let body: PageCreateRequest = req.parse()?;
                let caller = caller(&desk, &req).await?;
                desk.create(&caller, body).map_or_else(failed, |created| Ok(page(201, &created)))
            }
        })
    };
    let save = {
        let desk = desk.clone();
        RouteDef::put("/api/pages/{id}", move |req: Request| {
            let desk = desk.clone();
            async move {
                let id = id(&req)?;
                let body: PageUpdateRequest = req.parse()?;
                let caller = caller(&desk, &req).await?;
                desk.save(&caller, id, body).map_or_else(failed, |saved| Ok(page(200, &saved)))
            }
        })
    };
    let edit = {
        let desk = desk.clone();
        RouteDef::post("/api/pages/{id}/edit", move |req: Request| {
            let desk = desk.clone();
            async move {
                let id = id(&req)?;
                let body: PageEditRequest = req.parse()?;
                let caller = caller(&desk, &req).await?;
                desk.edit(&caller, id, &body).map_or_else(failed, |edited| Ok(page(200, &edited)))
            }
        })
    };
    let delete = {
        let desk = desk.clone();
        RouteDef::delete("/api/pages/{id}", move |req: Request| {
            let desk = desk.clone();
            async move { desk.remove(id(&req)?).map_or_else(failed, |()| Ok(Response::json(200, &Done { ok: true }))) }
        })
    };
    vec![
        list.access(Access::open()),
        read.access(Access::open()),
        create.access(Access::open()),
        save.access(Access::open()),
        edit.access(Access::open()),
        delete.access(Access::ui_token()),
    ]
}
