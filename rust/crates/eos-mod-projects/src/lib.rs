//! Projects and recent folders, read side (`manager/routes/projects.ts`,
//! `GET /fs/recents` of `fs-git.ts`).
//!
//! Saving and deleting a project widen what an agent may touch and need the
//! user's token; those routes are not registered yet.

use std::sync::Arc;

use eos_contracts::Project;
use eos_core::store::{ProjectStore, RecentFolders};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
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
        vec![
            RouteDef::get("/projects", list).access(Access::open()),
            RouteDef::get("/fs/recents", recent).access(Access::open().phone(Tier::Read)),
        ]
    }
}
