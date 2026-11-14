//! The configured memory sources (CLAUDE.md, AGENTS.md-style files) with their
//! defaults filled in.

use eos_contracts::MemorySource;

/// A source ready to read: the config key folded in as `id`, defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedMemorySource {
    pub id: String,
    pub label: String,
    /// Files of the user, `~` standing for their home folder.
    pub user_paths: Vec<String>,
    /// File names looked for from a session's folder up to its repository root.
    pub project_filenames: Vec<String>,
    pub priority: f64,
    /// Backend kinds that load this source themselves.
    pub assume_native_for: Vec<String>,
}

/// The enabled sources of `config.memory.sources`, in the order they appear
/// in a prompt: by priority, then by id.
pub fn resolve_memory_sources<'a>(
    sources: impl IntoIterator<Item = (&'a str, &'a MemorySource)>,
) -> Vec<ResolvedMemorySource> {
    let mut resolved: Vec<ResolvedMemorySource> = sources
        .into_iter()
        .filter(|(_, source)| source.enabled.unwrap_or(true))
        .map(|(id, source)| ResolvedMemorySource {
            id: id.to_owned(),
            label: source.label.clone().unwrap_or_else(|| id.to_owned()),
            user_paths: source.user_paths.clone().unwrap_or_default(),
            project_filenames: source.project_filenames.clone().unwrap_or_default(),
            priority: source.priority.map_or(0.0, |p| p.0),
            assume_native_for: source.assume_native_for.clone().unwrap_or_default(),
        })
        .collect();
    // Ids are config keys; lowercase first approximates the collation
    // `localeCompare` gives them.
    resolved.sort_by(|a, b| {
        a.priority
            .partial_cmp(&b.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.to_lowercase().cmp(&b.id.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    resolved
}

#[cfg(test)]
mod tests {
    use eos_contracts::Num;

    use super::*;

    fn spec() -> MemorySource {
        MemorySource {
            enabled: None,
            label: None,
            user_paths: None,
            project_filenames: None,
            priority: None,
            assume_native_for: None,
        }
    }

    #[test]
    fn drops_disabled_sources_fills_defaults_and_orders_by_priority_then_id() {
        let claude = MemorySource {
            label: Some("CLAUDE.md".into()),
            user_paths: Some(vec!["~/.claude/CLAUDE.md".into()]),
            project_filenames: Some(vec!["CLAUDE.md".into()]),
            assume_native_for: Some(vec!["claude".into()]),
            ..spec()
        };
        let agents = MemorySource { priority: Some(Num(-1.0)), ..spec() };
        let off = MemorySource { enabled: Some(false), ..spec() };
        let bare = spec();
        let resolved = resolve_memory_sources([("claude", &claude), ("off", &off), ("agents", &agents), ("b", &bare)]);
        assert_eq!(resolved.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["agents", "b", "claude"]);
        assert_eq!(resolved[0].label, "agents");
        assert!(resolved[1].user_paths.is_empty() && resolved[1].assume_native_for.is_empty());
        assert_eq!(resolved[2].label, "CLAUDE.md");
        assert_eq!(resolved[2].assume_native_for, ["claude"]);
    }
}
