//! The system prompt of one session.
//!
//! Once per spawn: the session's facts are derived from what the app knows
//! about it, the fragments whose `when` holds are picked and ordered, each is
//! rendered with the session's values, and the blocks are joined. Facts
//! (camelCase) drive `when`; variables (UPPER_SNAKE) are what bodies show.

use eos_contracts::builtin_plugins::plugin_off_fact;
use eos_contracts::{SessionFacts, SessionFactsRole};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::prompt::Fragment;
use crate::select::select_fragments;
use crate::service::PromptService;
use crate::template::{VariableScope, js_trim};

/// What both preambles show for a user who has told Eos nothing about
/// themselves; also what a caller that knows no profile gets.
pub const DEFAULT_USER_PREFERENCES: &str = "`<user_preferences>`\n\nThe user has specified the following personal preferences for how Claude should respond:\n\nBe as concise and direct as possible. Limit unnecessary explanation and verbosity. A good test of whether your writing is concise is whether you can remove words and still get the same point across.\n\nPlease keep these preferences in mind when responding.\n\n`</user_preferences>`";

/// What the app knows about a session when it starts: the assembler's only input.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpawnContext {
    pub role: SessionFactsRole,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub worker_id: Option<String>,
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    pub permission_mode: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub worktree_dir: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub repo_root: Option<String>,
    #[serde(default)]
    pub is_attached: bool,
    #[serde(default)]
    pub has_mcp: bool,
    #[serde(default)]
    pub can_collaborate: bool,
    /// The worker definition's name; empty for none.
    #[serde(default)]
    pub worker_definition: String,
    /// The available workers as an orchestrator's prompt lists them.
    #[serde(default)]
    pub worker_definition_catalog: String,
    // The session's own provider, already rendered.
    #[serde(default)]
    pub persona_name: Option<String>,
    #[serde(default)]
    pub model_tier_table: Option<String>,
    #[serde(default)]
    pub default_tier: Option<String>,
    #[serde(default)]
    pub effort_section: Option<String>,
    #[serde(default)]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub effort_supported: Option<bool>,
    /// The user's profile block. `None`: the stock preferences.
    #[serde(default)]
    pub user_profile: Option<String>,
    /// What features fill for this session (visual answers' `GENUI_LEVEL`);
    /// they win over the built-in variables.
    #[serde(default)]
    pub variables: VariableScope,
    /// Built-in plugins that were off when the session started: each sets
    /// its `plugin-off:<id>` fact, and the fragments about it drop out.
    #[serde(default)]
    pub disabled_plugins: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssembleResult {
    /// The prompt; empty when no fragment applies.
    pub text: String,
    pub facts: SessionFacts,
    pub active_fragment_ids: Vec<String>,
}

/// The facts of a session. The ones that can change while it runs (git
/// state, the system, the shell) are left blank on purpose: the prompt is
/// fixed at start, so nothing may be decided on them.
fn derive_facts(ctx: &SessionSpawnContext) -> SessionFacts {
    SessionFacts {
        role: ctx.role,
        is_subagent: ctx.parent_id.is_some(),
        is_git_repo: false,
        is_worktree: ctx.worktree_dir.is_some(),
        is_attached: ctx.is_attached,
        model: ctx.model.clone(),
        effort: ctx.effort.clone(),
        permission_mode: ctx.permission_mode.clone(),
        os: String::new(),
        shell: String::new(),
        has_mcp: ctx.has_mcp,
        can_collaborate: ctx.can_collaborate,
        worker_definition: ctx.worker_definition.clone(),
        extra: ctx.disabled_plugins.iter().map(|id| (plugin_off_fact(id), Value::Bool(true))).collect(),
    }
}

fn role_name(role: SessionFactsRole) -> &'static str {
    match role {
        SessionFactsRole::Orchestrator => "orchestrator",
        SessionFactsRole::Worker => "worker",
        SessionFactsRole::Git => "git",
        SessionFactsRole::Focused => "focused",
    }
}

fn session_vars(ctx: &SessionSpawnContext) -> VariableScope {
    let text = |value: &Option<String>| Value::String(value.clone().unwrap_or_default());
    let mut vars = VariableScope::new();
    let mut set = |name: &str, value: Value| {
        vars.insert(name.to_owned(), value);
    };
    set("AGENT_NAME", ctx.name.clone().into());
    set("WORKER_ID", text(&ctx.worker_id));
    set("WORKTREE_DIR", text(&ctx.worktree_dir));
    set("BRANCH", text(&ctx.branch));
    set("REPO_ROOT", text(&ctx.repo_root));
    set("CWD", text(&ctx.cwd));
    set("MODEL", ctx.model.clone().into());
    set("ROLE", role_name(ctx.role).into());
    set("EFFORT", text(&ctx.effort));
    set("PERMISSION_MODE", ctx.permission_mode.clone().into());
    set("AVAILABLE_WORKERS_CATALOG", ctx.worker_definition_catalog.clone().into());
    set("PERSONA_NAME", text(&ctx.persona_name));
    set("MODEL_TIER_TABLE", text(&ctx.model_tier_table));
    set("DEFAULT_TIER", text(&ctx.default_tier));
    set("EFFORT_SECTION", text(&ctx.effort_section));
    set("DEFAULT_EFFORT", text(&ctx.default_effort));
    set("EFFORT_SUPPORTED", ctx.effort_supported.unwrap_or(false).into());
    set("USER_PROFILE", ctx.user_profile.clone().unwrap_or_else(|| DEFAULT_USER_PREFERENCES.to_owned()).into());
    for (name, value) in &ctx.variables {
        vars.insert(name.clone(), value.clone());
    }
    vars
}

/// Each block trimmed, the empty ones dropped, a blank line between them and
/// one line feed at the end.
pub fn compose_prompt(rendered: &[String]) -> String {
    let blocks: Vec<&str> = rendered.iter().map(|block| js_trim(block)).filter(|block| !block.is_empty()).collect();
    if blocks.is_empty() { String::new() } else { format!("{}\n", blocks.join("\n\n")) }
}

/// Assembles a session's system prompt. `extra` are fragments made for this
/// spawn alone (its worker definition's body); they are picked and ordered
/// with the library's. The library is read again first, so an edited prompt
/// applies to the next spawn.
pub fn assemble_system_prompt(
    prompts: &PromptService,
    ctx: &SessionSpawnContext,
    extra: Vec<Fragment>,
) -> AssembleResult {
    prompts.registry().reload();
    let facts = derive_facts(ctx);
    let fact_map = match serde_json::to_value(&facts) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let vars = session_vars(ctx);

    let mut fragments = prompts.registry().fragments();
    fragments.extend(extra);
    let selected = select_fragments(fragments, &fact_map);
    let no_locals = VariableScope::new();
    let rendered: Vec<String> = selected.iter().map(|f| prompts.render_parsed(&f.prompt, &no_locals, &vars)).collect();

    AssembleResult {
        text: compose_prompt(&rendered),
        facts,
        active_fragment_ids: selected.into_iter().map(|f| f.prompt.id).collect(),
    }
}
