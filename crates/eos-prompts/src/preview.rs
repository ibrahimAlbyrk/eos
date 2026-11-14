//! The system prompt a session would get, without starting one: the same
//! assembly as a spawn, over stand-in session values.

use eos_contracts::SessionFactsRole;
use eos_domain::ProviderIdentity;

use crate::assemble::{AssembleResult, SessionSpawnContext, assemble_system_prompt};
use crate::genui_level::genui_prompt_variables;
use crate::service::PromptService;
use crate::tiers::{default_effort_for, render_effort_section, render_model_tier_table};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewOptions {
    /// `Orchestrator` or `Worker`.
    pub role: SessionFactsRole,
    /// The session's provider.
    pub identity: ProviderIdentity,
    /// A worker's role fragments all ask for a subagent: without it a worker
    /// is its preamble alone.
    pub subagent: bool,
    pub worktree: bool,
    /// The worker definition's name; empty for none.
    pub definition: String,
    /// The folder the session would work in.
    pub cwd: String,
}

/// The session a preview stands for.
pub fn preview_context(options: &PreviewOptions) -> SessionSpawnContext {
    let identity = &options.identity;
    let orchestrator = options.role == SessionFactsRole::Orchestrator;
    let role = if orchestrator { "orchestrator" } else { "worker" };
    SessionSpawnContext {
        role: options.role,
        parent_id: options.subagent.then(|| "orch-preview".to_owned()),
        name: role.to_owned(),
        worker_id: Some(if orchestrator { "o-preview" } else { "w-preview" }.to_owned()),
        model: identity.tiers.iter().find(|t| t.name == "high").map(|t| t.model.clone()).unwrap_or_default(),
        effort: None,
        permission_mode: "acceptEdits".to_owned(),
        cwd: Some(options.cwd.clone()),
        worktree_dir: options.worktree.then(|| "/path/to/worktree".to_owned()),
        branch: options.worktree.then(|| "eos-preview".to_owned()),
        repo_root: options.worktree.then(|| options.cwd.clone()),
        is_attached: false,
        has_mcp: false,
        can_collaborate: false,
        worker_definition: options.definition.clone(),
        worker_definition_catalog: String::new(),
        persona_name: Some(identity.persona.clone()),
        model_tier_table: Some(render_model_tier_table(identity)),
        default_tier: None,
        effort_section: Some(render_effort_section(identity).to_owned()),
        default_effort: Some(default_effort_for(identity).to_owned()),
        effort_supported: Some(identity.effort_supported),
        user_profile: None,
        variables: genui_prompt_variables(None),
        disabled_plugins: Vec::new(),
    }
}

pub fn render_preview(prompts: &PromptService, options: &PreviewOptions) -> AssembleResult {
    assemble_system_prompt(prompts, &preview_context(options), Vec::new())
}
