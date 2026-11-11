//! The provider's own model and effort guidance, as prompts show it
//! (`manager/shared/tier-prompt-render.ts`).

use eos_domain::ProviderIdentity;

/// What a tier is for when its provider says nothing: by rank.
fn use_for_by_rank(rank: usize, count: usize) -> &'static str {
    if rank == 0 {
        "ambiguous problems, multi-file design, debugging"
    } else if rank == count - 1 {
        "trivial edits, summaries, greps — fastest"
    } else {
        "well-specified refactors, straightforward tests, mechanical edits"
    }
}

/// `MODEL_TIER_TABLE`: one row per tier, strongest first, the default marked.
pub fn render_model_tier_table(identity: &ProviderIdentity) -> String {
    let count = identity.tiers.len();
    let default = identity.default_tier_name();
    let mut lines = vec!["| tier | model | use for |".to_owned(), "|---|---|---|".to_owned()];
    for (rank, tier) in identity.tiers.iter().enumerate() {
        let label = if tier.name == default { format!("{} (default)", tier.name) } else { tier.name.clone() };
        let hint = tier.hint.as_deref().unwrap_or_else(|| use_for_by_rank(rank, count));
        lines.push(format!("| {label} | {} | {hint} |", tier.model));
    }
    lines.join("\n")
}

const EFFORT_TABLE: &str = "| effort | use for |\n\
|---|---|\n\
| low | trivial mechanical edits, summaries, fixed-format output |\n\
| medium | routine, well-specified work |\n\
| high | substantial but straightforward implementation |\n\
| xhigh (default) | complex debugging, design, anything where wrong output is hard to recover from |\n\
| max | correctness-critical work — the strongest reasoning, when a wrong answer is unacceptable |";

/// `EFFORT_SECTION`: the effort table, or one line saying there is no such setting.
pub fn render_effort_section(identity: &ProviderIdentity) -> &'static str {
    if identity.effort_supported {
        EFFORT_TABLE
    } else {
        "This provider exposes no reasoning-effort lever — omit effort."
    }
}

/// `DEFAULT_EFFORT`: what to spawn with when nothing is asked.
pub fn default_effort_for(identity: &ProviderIdentity) -> &'static str {
    if identity.is_claude() { "xhigh" } else { "high" }
}
