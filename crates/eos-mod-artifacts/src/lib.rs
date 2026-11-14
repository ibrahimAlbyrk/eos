//! The claude.ai Artifact catalog: every artifact of every Claude sign-in, read
//! with that sign-in's own token.
//!
//! - `GET /api/artifacts`: the catalog from memory; stale sign-ins are read
//!   again in the background.
//! - `POST /api/artifacts/refresh`: every sign-in read now, answered when done.
//!
//! Both are the user's dashboard's only and never cross to another computer:
//! they list this computer's accounts' work. `artifacts:change` carries only
//! `{refreshing}`. A tool result that holds an artifact link re-reads the
//! sign-in its agent runs on (every sign-in when that is unknown).

mod catalog;
mod rules;

use std::sync::Arc;

use eos_contracts::AgentEvent;
use eos_contracts::builtin_plugins::ids::ARTIFACTS;
use eos_core::BoxFuture;
use eos_core::accounts::PlanAccess;
use eos_runtime::access::Access;
use eos_runtime::bus::TopicDecl;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;

pub use catalog::{ARTIFACTS_CHANGE, Catalog, DEBOUNCE_MS, Parts, STALE_MS, Stopped};
pub use rules::{announces_artifact, merge_artifacts};

pub struct ArtifactsModule {
    catalog: Arc<Catalog>,
    access: Arc<dyn PlanAccess>,
}

impl std::fmt::Debug for ArtifactsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactsModule").finish_non_exhaustive()
    }
}

impl ArtifactsModule {
    pub fn new(parts: Parts) -> Self {
        let access = parts.access.clone();
        Self { catalog: Catalog::new(parts), access }
    }

    pub fn catalog(&self) -> &Arc<Catalog> {
        &self.catalog
    }
}

fn stopped(e: Stopped) -> ApiError {
    ApiError::Internal(e.to_string())
}

impl Module for ArtifactsModule {
    fn id(&self) -> &'static str {
        "artifacts"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(ARTIFACTS)
    }

    fn routes(&self) -> Vec<RouteDef> {
        let (get, refresh) = (self.catalog.clone(), self.catalog.clone());
        let user = Access::ui_token().local_only();
        vec![
            RouteDef::get("/api/artifacts", move |_req: Request| {
                let catalog = get.clone();
                async move { Ok(Response::json(200, &catalog.get().await.map_err(stopped)?)) }
            })
            .access(user),
            RouteDef::post("/api/artifacts/refresh", move |_req: Request| {
                let catalog = refresh.clone();
                async move { Ok(Response::json(200, &catalog.refresh().await.map_err(stopped)?)) }
            })
            .access(user),
        ]
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![ARTIFACTS_CHANGE.decl()]
    }

    fn on_agent_event(&self, worker_id: &str, event: &AgentEvent) {
        if announces_artifact(event) {
            self.catalog.invalidate(self.access.login_of_worker("anthropic", worker_id));
        }
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            // Records where reads run: an agent's event may arrive off the runtime.
            self.catalog.attach();
            Ok(())
        })
    }
}
