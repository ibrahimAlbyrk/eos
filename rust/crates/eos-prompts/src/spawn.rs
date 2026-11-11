//! From a spawn to its system prompt: the assembly the composition root does
//! for every session (`assembleAppendText` in `manager/container.ts`), for a
//! session whose engine carries its own base prompt.

use eos_contracts::SessionFactsRole;
use eos_core::prompt::ProfileText;
use eos_domain::ProviderIdentity;

use crate::assemble::{SessionSpawnContext, assemble_system_prompt};
use crate::prompt::definition_fragment;
use crate::service::PromptService;
use crate::template::{VariableScope, js_trim};
use crate::tiers::{default_effort_for, render_effort_section, render_model_tier_table};

/// What a spawn knows that its prompt depends on.
#[derive(Debug, Clone)]
pub struct SpawnPrompt<'a> {
    pub id: &'a str,
    pub is_orchestrator: bool,
    /// The spawn's role when it has one of its own: `git`, `focused`.
    pub role: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub name: Option<&'a str>,
    /// A tier, an alias or a model id; `None` is the provider's default tier.
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub permission_mode: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub worktree_dir: Option<&'a str>,
    /// The repository a worktree was made from.
    pub worktree_from: Option<&'a str>,
    pub branch: Option<&'a str>,
    /// The session works in another session's workspace.
    pub attached: bool,
    pub collaborate: bool,
    pub worker_definition: Option<&'a str>,
    /// The resolved definition's body: it becomes a fragment of this prompt.
    pub worker_definition_body: Option<&'a str>,
    /// The available workers, rendered; shown to an orchestrator only.
    pub worker_catalog: &'a str,
    /// The session's own provider.
    pub identity: &'a ProviderIdentity,
    pub profile: ProfileText,
    /// What the feature modules fill for this session.
    pub variables: VariableScope,
    /// Built-in plugins that are off right now.
    pub disabled_plugins: &'a [String],
}

fn role_of(spawn: &SpawnPrompt<'_>) -> SessionFactsRole {
    match (spawn.is_orchestrator, spawn.role) {
        (true, _) => SessionFactsRole::Orchestrator,
        (false, Some("git")) => SessionFactsRole::Git,
        (false, Some("focused")) => SessionFactsRole::Focused,
        (false, _) => SessionFactsRole::Worker,
    }
}

/// The session the assembler is asked about.
pub fn spawn_context(spawn: &SpawnPrompt<'_>) -> SessionSpawnContext {
    let role = role_of(spawn);
    let identity = spawn.identity;
    let own = |value: Option<&str>| value.map(str::to_owned);
    // A focused session is a plain Claude Code session: it never carried the
    // stock preferences, so a user without a profile adds nothing there.
    let user_profile = if role == SessionFactsRole::Focused && spawn.profile.empty {
        String::new()
    } else {
        spawn.profile.text.clone()
    };
    SessionSpawnContext {
        role,
        parent_id: own(spawn.parent_id),
        name: spawn.name.unwrap_or(spawn.id).to_owned(),
        worker_id: Some(spawn.id.to_owned()),
        model: identity.resolve_tier(spawn.model.unwrap_or_else(|| identity.default_tier_name())).to_owned(),
        effort: own(spawn.effort),
        permission_mode: spawn.permission_mode.unwrap_or("bypassPermissions").to_owned(),
        cwd: own(spawn.cwd.or(spawn.worktree_dir).or(spawn.worktree_from)),
        worktree_dir: own(spawn.worktree_dir),
        branch: own(spawn.branch),
        repo_root: own(spawn.worktree_from),
        is_attached: spawn.attached,
        has_mcp: false,
        can_collaborate: spawn.collaborate,
        worker_definition: spawn.worker_definition.unwrap_or_default().to_owned(),
        worker_definition_catalog: if role == SessionFactsRole::Orchestrator {
            spawn.worker_catalog.to_owned()
        } else {
            String::new()
        },
        persona_name: Some(identity.persona.clone()),
        model_tier_table: Some(render_model_tier_table(identity)),
        default_tier: Some(identity.default_tier_name().to_owned()),
        effort_section: Some(render_effort_section(identity).to_owned()),
        default_effort: Some(default_effort_for(identity).to_owned()),
        effort_supported: Some(identity.effort_supported),
        user_profile: Some(user_profile),
        variables: spawn.variables.clone(),
        disabled_plugins: spawn.disabled_plugins.to_vec(),
    }
}

/// The text appended to the engine's own system prompt for this spawn;
/// `None` when no fragment applies (nothing is appended).
pub fn system_prompt_for(prompts: &PromptService, spawn: &SpawnPrompt<'_>) -> Option<String> {
    let extra = spawn
        .worker_definition
        .zip(spawn.worker_definition_body)
        .and_then(|(name, body)| definition_fragment(name, body))
        .into_iter()
        .collect();
    let text = assemble_system_prompt(prompts, &spawn_context(spawn), extra).text;
    (!js_trim(&text).is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn<'a>(identity: &'a ProviderIdentity, off: &'a [String]) -> SpawnPrompt<'a> {
        SpawnPrompt {
            id: "w-1",
            is_orchestrator: false,
            role: None,
            parent_id: Some("o-1"),
            name: None,
            model: None,
            effort: None,
            permission_mode: None,
            cwd: None,
            worktree_dir: Some("/wt"),
            worktree_from: Some("/repo"),
            branch: Some("eos-x"),
            attached: false,
            collaborate: true,
            worker_definition: Some("explorer"),
            worker_definition_body: None,
            worker_catalog: "- explorer",
            identity,
            profile: ProfileText { text: "stock".into(), empty: true },
            variables: VariableScope::new(),
            disabled_plugins: off,
        }
    }

    #[test]
    fn a_spawn_becomes_the_session_the_assembler_sees() {
        let claude = ProviderIdentity::claude();
        let ctx = spawn_context(&spawn(&claude, &[]));
        assert_eq!((ctx.role, ctx.name.as_str(), ctx.model.as_str()), (SessionFactsRole::Worker, "w-1", "opus"));
        assert_eq!((ctx.cwd.as_deref(), ctx.repo_root.as_deref()), (Some("/wt"), Some("/repo")));
        assert_eq!(ctx.permission_mode, "bypassPermissions");
        assert_eq!(ctx.worker_definition_catalog, "", "only an orchestrator sees the catalog");
        assert_eq!(ctx.user_profile.as_deref(), Some("stock"));
        assert_eq!((ctx.default_tier.as_deref(), ctx.default_effort.as_deref()), (Some("high"), Some("xhigh")));

        let orchestrator =
            SpawnPrompt { is_orchestrator: true, role: Some("git"), model: Some("max"), ..spawn(&claude, &[]) };
        let ctx = spawn_context(&orchestrator);
        assert_eq!((ctx.role, ctx.model.as_str()), (SessionFactsRole::Orchestrator, "fable"));
        assert_eq!(ctx.worker_definition_catalog, "- explorer");

        let focused = SpawnPrompt { role: Some("focused"), ..spawn(&claude, &[]) };
        assert_eq!(spawn_context(&focused).user_profile.as_deref(), Some(""), "no profile, no block");
        let known = ProfileText { text: "Ada".into(), empty: false };
        let focused = SpawnPrompt { role: Some("focused"), profile: known, ..spawn(&claude, &[]) };
        assert_eq!(spawn_context(&focused).user_profile.as_deref(), Some("Ada"));
    }
}
