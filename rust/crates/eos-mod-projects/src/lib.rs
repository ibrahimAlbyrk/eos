//! Projects and recent folders (`manager/routes/projects.ts`, the recents
//! routes of `fs-git.ts`).
//!
//! A project's folders become extra folders an agent may work in, so saving
//! and deleting one — and forgetting a recent folder — need the user's own
//! dashboard. The handlers ask for it after they have checked the request,
//! as today's do.

use std::sync::Arc;

use std::path::Path;

use eos_contracts::{Project, ProjectDeleteRequest, ProjectUpsertRequest, RecentRemoveRequest};
use eos_core::store::{ProjectStore, RecentFolders};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use serde::Serialize;

#[derive(Serialize)]
struct ProjectsResponse {
    projects: Vec<Project>,
}

#[derive(Serialize)]
struct RecentsResponse {
    paths: Vec<String>,
}

#[derive(Serialize)]
struct Saved {
    project: Project,
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

/// An absolute path with no NUL byte.
fn is_safe_abs_path(path: &str) -> bool {
    !path.contains('\0') && Path::new(path).is_absolute()
}

fn require_user(req: &Request) -> Result<(), ApiError> {
    if req.speaks_for_user() { Ok(()) } else { Err(ApiError::PermissionDenied("ui token required".into())) }
}

fn save(projects: &dyn ProjectStore, recents: &dyn RecentFolders, req: &Request) -> Result<Response, ApiError> {
    let body: ProjectUpsertRequest = req.parse()?;
    require_user(req)?;
    if !body.folders.iter().all(|folder| is_safe_abs_path(folder)) {
        return Err(ApiError::Validation("folders must be absolute".into()));
    }
    let project = projects.upsert(body)?;
    for folder in &project.folders {
        recents.push(folder);
    }
    // The first folder again, so it is the most recent of them.
    if let Some(primary) = project.folders.first() {
        recents.push(primary);
    }
    Ok(Response::json(200, &Saved { project }))
}

// Forgets the project and takes its folders out of the recent ones; agents are untouched.
fn delete(projects: &dyn ProjectStore, recents: &dyn RecentFolders, req: &Request) -> Result<Response, ApiError> {
    let body: ProjectDeleteRequest = req.parse()?;
    require_user(req)?;
    let Some(removed) = projects.remove(&body.id)? else {
        return Err(ApiError::NotFound("project not found".into()));
    };
    for folder in &removed.folders {
        recents.remove(folder);
    }
    Ok(Response::json(200, &Done { ok: true }))
}

fn forget_recent(recents: &dyn RecentFolders, req: &Request) -> Result<Response, ApiError> {
    let body: RecentRemoveRequest = req.parse()?;
    if !is_safe_abs_path(&body.path) {
        return Err(ApiError::Validation("cwd must be absolute".into()));
    }
    require_user(req)?;
    recents.remove(&body.path);
    Ok(Response::json(200, &Done { ok: true }))
}

pub struct ProjectsModule {
    projects: Arc<dyn ProjectStore>,
    recents: Arc<dyn RecentFolders>,
}

impl std::fmt::Debug for ProjectsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectsModule").finish_non_exhaustive()
    }
}

impl ProjectsModule {
    pub fn new(projects: Arc<dyn ProjectStore>, recents: Arc<dyn RecentFolders>) -> Self {
        Self { projects, recents }
    }
}

impl Module for ProjectsModule {
    fn id(&self) -> &'static str {
        "projects"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let projects = self.projects.clone();
        let list = move |_req: Request| {
            let body = ProjectsResponse { projects: projects.list() };
            async move { Ok(Response::json(200, &body)) }
        };
        let recents = self.recents.clone();
        // Checks each folder on disk, so it runs off the async threads.
        let recent = move |_req: Request| {
            let recents = recents.clone();
            async move {
                let paths = tokio::task::spawn_blocking(move || recents.list()).await.unwrap_or_default();
                Ok(Response::json(200, &RecentsResponse { paths }))
            }
        };
        // The stores read and write small files: off the async threads.
        let (projects, recents) = (self.projects.clone(), self.recents.clone());
        let changing = move |run: fn(&dyn ProjectStore, &dyn RecentFolders, &Request) -> Result<Response, ApiError>| {
            let (projects, recents) = (projects.clone(), recents.clone());
            move |req: Request| {
                let (projects, recents) = (projects.clone(), recents.clone());
                async move {
                    tokio::task::spawn_blocking(move || run(projects.as_ref(), recents.as_ref(), &req))
                        .await
                        .unwrap_or_else(|e| Err(ApiError::Internal(e.to_string())))
                }
            }
        };
        vec![
            RouteDef::get("/projects", list).access(Access::open()),
            RouteDef::put("/projects", changing(save)).access(Access::open()),
            RouteDef::post("/projects/delete", changing(delete)).access(Access::open()),
            RouteDef::get("/fs/recents", recent).access(Access::open().phone(Tier::Read)),
            RouteDef::post("/fs/recents/remove", changing(|_, recents, req| forget_recent(recents, req)))
                .access(Access::open()),
        ]
    }
}
