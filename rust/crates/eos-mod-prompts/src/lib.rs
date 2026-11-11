//! Looking into the prompt system (`manager/routes/prompts.ts`). Read-only.
//!
//! | Route | |
//! |---|---|
//! | `GET /api/prompts` | every prompt of the library with its place in system prompts |
//! | `POST /api/prompts/preview` | the system prompt a session with the given facts would get |
//!
//! The preview shows the user's own profile block, so it exists only when a
//! profile renderer is given.

use std::sync::Arc;

use eos_contracts::{PromptPreviewRequest, PromptPreviewRequestRole, PromptPreviewResponse, SessionFactsRole};
use eos_core::prompt::ProfileRenderer;
use eos_prompts::prompt::{dpi_of, layer_name};
use eos_prompts::{PromptService, SessionSpawnContext, VariableScope, assemble_system_prompt};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use serde::Serialize;

pub struct PromptsModule {
    prompts: Arc<PromptService>,
    profile: Option<Arc<dyn ProfileRenderer>>,
}

impl std::fmt::Debug for PromptsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptsModule").field("preview", &self.profile.is_some()).finish_non_exhaustive()
    }
}

impl PromptsModule {
    /// `prompts` renders with the tool names as its globals, as a spawn does.
    /// Without `profile` the preview route is not offered.
    pub fn new(prompts: Arc<PromptService>, profile: Option<Arc<dyn ProfileRenderer>>) -> Self {
        Self { prompts, profile }
    }
}

/// One row of the catalog. `layer` and `priority` are null for a prompt that
/// is a template only.
#[derive(Serialize)]
struct CatalogEntry<'a> {
    id: &'a str,
    description: Option<&'a str>,
    layer: Option<&'static str>,
    priority: Option<i64>,
    conditional: bool,
    variables: Vec<&'a str>,
}

#[derive(Serialize)]
struct Catalog<'a> {
    prompts: Vec<CatalogEntry<'a>>,
}

fn catalog(prompts: Arc<PromptService>) -> RouteDef {
    RouteDef::get("/api/prompts", move |_req: Request| {
        let prompts = prompts.clone();
        async move {
            prompts.registry().reload();
            let library = prompts.registry().list();
            let rows = library
                .iter()
                .map(|prompt| {
                    let dpi = dpi_of(prompt);
                    CatalogEntry {
                        id: &prompt.id,
                        description: prompt.frontmatter.description.as_deref(),
                        layer: dpi.as_ref().map(|d| layer_name(d.layer)),
                        priority: dpi.as_ref().map(|d| d.priority),
                        conditional: dpi.as_ref().is_some_and(|d| d.when.is_some()),
                        variables: prompt.frontmatter.variables.iter().map(|v| v.0.as_str()).collect(),
                    }
                })
                .collect();
            Ok(Response::json(200, &Catalog { prompts: rows }))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

/// The session a preview request stands for: its fields, and the user's
/// profile as a Claude session in that folder would get it.
fn context(body: PromptPreviewRequest, profile: &dyn ProfileRenderer) -> SessionSpawnContext {
    let user_profile = profile.render("claude", body.cwd.as_deref(), None).text;
    SessionSpawnContext {
        role: match body.role {
            PromptPreviewRequestRole::Orchestrator => SessionFactsRole::Orchestrator,
            PromptPreviewRequestRole::Worker => SessionFactsRole::Worker,
            PromptPreviewRequestRole::Git => SessionFactsRole::Git,
        },
        parent_id: body.parent_id,
        name: body.name,
        worker_id: body.worker_id,
        model: body.model,
        effort: body.effort,
        permission_mode: body.permission_mode,
        cwd: body.cwd,
        worktree_dir: body.worktree_dir,
        branch: body.branch,
        repo_root: body.repo_root,
        is_attached: body.is_attached,
        has_mcp: body.has_mcp,
        can_collaborate: body.can_collaborate,
        worker_definition: body.worker_definition,
        worker_definition_catalog: body.worker_definition_catalog,
        persona_name: None,
        model_tier_table: None,
        default_tier: None,
        effort_section: None,
        default_effort: None,
        effort_supported: None,
        user_profile: Some(user_profile),
        variables: VariableScope::new(),
        disabled_plugins: Vec::new(),
    }
}

fn preview(prompts: Arc<PromptService>, profile: Arc<dyn ProfileRenderer>) -> RouteDef {
    RouteDef::post("/api/prompts/preview", move |req: Request| {
        let (prompts, profile) = (prompts.clone(), profile.clone());
        async move {
            let body: PromptPreviewRequest = req.parse()?;
            let result = assemble_system_prompt(&prompts, &context(body, profile.as_ref()), Vec::new());
            Ok(Response::json(
                200,
                &PromptPreviewResponse {
                    text: result.text,
                    facts: result.facts,
                    active_fragment_ids: result.active_fragment_ids,
                },
            ))
        }
    })
    .access(Access::open())
}

impl Module for PromptsModule {
    fn id(&self) -> &'static str {
        "prompts"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = vec![catalog(self.prompts.clone())];
        if let Some(profile) = &self.profile {
            routes.push(preview(self.prompts.clone(), profile.clone()));
        }
        routes
    }
}
