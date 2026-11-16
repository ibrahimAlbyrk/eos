//! The models a focused chat's subagents can run on, as prompt text
//! (`MODELS_BY_PROVIDER`). Fixed at spawn like every variable.

use eos_contracts::ProviderModels;

/// The aliases the Agent tool takes for Claude models.
const CLAUDE: &str = "- Claude: `sonnet`, `opus`, `haiku`, `fable`";
/// A provider can list hundreds of models; the prompt names this many.
const LISTED: usize = 12;

/// One line per provider a session can start on now, Claude first. Empty
/// when no other provider is ready: the Agent tool's own text covers Claude.
pub fn render_models_by_provider(providers: &[ProviderModels]) -> String {
    let lines: Vec<String> = providers.iter().filter(|p| p.ready && !p.models.is_empty()).map(provider_line).collect();
    if lines.is_empty() {
        return String::new();
    }
    std::iter::once(CLAUDE.to_owned()).chain(lines).collect::<Vec<_>>().join("\n")
}

fn provider_line(provider: &ProviderModels) -> String {
    let names: Vec<String> = provider.models.iter().take(LISTED).map(|m| format!("`{}`", m.id)).collect();
    let more = provider.models.len().saturating_sub(LISTED);
    let rest = if more > 0 { format!(", and {more} more of its models by their id") } else { String::new() };
    format!("- {}: {}{rest}", provider.label, names.join(", "))
}

#[cfg(test)]
mod tests {
    use eos_contracts::ProviderModel;

    use super::*;

    fn provider(label: &str, ready: bool, ids: &[String]) -> ProviderModels {
        let model = |id: &String| ProviderModel {
            id: id.clone(),
            display_name: id.clone(),
            context_window: None,
            effort_levels: None,
            default_effort: None,
        };
        ProviderModels {
            id: label.to_lowercase(),
            label: label.to_owned(),
            ready,
            models: ids.iter().map(model).collect(),
        }
    }

    #[test]
    fn ready_providers_are_listed_after_claude() {
        let many: Vec<String> = (0..15).map(|n| format!("router/m{n}")).collect();
        let listed = render_models_by_provider(&[
            provider("ChatGPT", true, &["gpt-5.5".to_owned()]),
            provider("DeepSeek", false, &["deepseek/deepseek-chat".to_owned()]),
            provider("Router", true, &many),
        ]);
        let lines: Vec<&str> = listed.lines().collect();
        assert_eq!(lines[..2], [CLAUDE, "- ChatGPT: `gpt-5.5`"]);
        assert!(lines[2].starts_with("- Router: `router/m0`, ") && lines[2].contains("`router/m11`"), "{}", lines[2]);
        assert!(lines[2].ends_with(", and 3 more of its models by their id") && !lines[2].contains("m12"));
        assert_eq!(lines.len(), 3, "a provider without a key is left out");
    }

    #[test]
    fn nothing_is_said_with_claude_alone() {
        assert_eq!(render_models_by_provider(&[provider("ChatGPT", false, &[])]), "");
        assert_eq!(render_models_by_provider(&[]), "");
    }
}
