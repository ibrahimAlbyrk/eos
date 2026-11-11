//! Model tiers (`core/src/domain/model-tier.ts`).
//!
//! A spawn asks for a tier — a provider's own name for a level of power
//! (`high`, `max`, …) — not a model id; the provider's identity maps it to a
//! concrete model once, at spawn. Everything after that (rows, prices, the
//! engine) sees the model, never the tier. Tiers say which model; effort
//! (how hard it thinks) is a separate axis and never takes part here.

/// One tier: the provider's label and the model it stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TierSpec {
    pub name: String,
    pub model: String,
    /// "Use for" guidance for the prompt's tier table; without it the text
    /// comes from the tier's rank.
    pub hint: Option<String>,
}

/// The ranked names every built-in provider defines, strongest first.
pub const BASELINE_TIER_NAMES: [&str; 3] = ["high", "medium", "low"];

/// How a provider presents itself to the prompt and to a spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderIdentity {
    /// What the model calls itself ("Claude", "DeepSeek", …).
    pub persona: String,
    /// Strongest first; never empty.
    pub tiers: Vec<TierSpec>,
    /// The tier a spawn gets when it names none; `None` is the first tier.
    pub default_tier: Option<String>,
    /// Whether the provider has a reasoning-effort setting.
    pub effort_supported: bool,
}

impl ProviderIdentity {
    /// Claude's own: the tiers are its aliases. `max` is the strongest, but
    /// the default stays `high`, so a stronger tier never upgrades spawns
    /// that asked for nothing.
    pub fn claude() -> Self {
        let tier = |name: &str, model: &str| TierSpec { name: name.into(), model: model.into(), hint: None };
        Self {
            persona: "Claude".into(),
            tiers: vec![tier("max", "fable"), tier("high", "opus"), tier("medium", "sonnet"), tier("low", "haiku")],
            default_tier: Some("high".into()),
            effort_supported: true,
        }
    }

    /// Claude-family, judged by the persona (the metered Anthropic lane
    /// presents the same identity).
    pub fn is_claude(&self) -> bool {
        self.persona == "Claude"
    }

    pub fn tier_names(&self) -> Vec<&str> {
        self.tiers.iter().map(|t| t.name.as_str()).collect()
    }

    /// `default_tier` when set, else the strongest tier.
    pub fn default_tier_name(&self) -> &str {
        self.default_tier.as_deref().or_else(|| self.tiers.first().map(|t| t.name.as_str())).unwrap_or_default()
    }

    pub fn has_tier(&self, name: &str) -> bool {
        self.tiers.iter().any(|t| t.name == name)
    }

    /// A `default_tier` that names no tier is a configuration mistake.
    pub fn default_tier_is_valid(&self) -> bool {
        self.default_tier.as_deref().is_none_or(|name| self.has_tier(name))
    }

    /// The model a requested model stands for here. A tier name gives its
    /// model; a Claude alias asked of another provider gives the model of the
    /// alias's rank (clamped to the nearest rank the provider defines, the
    /// stronger side first); anything else is a model id and passes through.
    /// Never fails: an unknown tier is refused where the spawn is validated.
    pub fn resolve_tier<'a>(&'a self, model: &'a str) -> &'a str {
        if let Some(tier) = self.tiers.iter().find(|t| t.name == model) {
            return &tier.model;
        }
        match alias_baseline(model) {
            Some(rank) if !self.is_claude() => self.baseline_model(rank),
            _ => model,
        }
    }

    fn baseline_model(&self, rank: usize) -> &str {
        for distance in 0..BASELINE_TIER_NAMES.len() {
            for index in [rank.checked_sub(distance), Some(rank + distance)].into_iter().flatten() {
                let Some(name) = BASELINE_TIER_NAMES.get(index) else { continue };
                if let Some(tier) = self.tiers.iter().find(|t| t.name == *name) {
                    return &tier.model;
                }
            }
        }
        self.tiers.first().map_or("", |t| t.model.as_str())
    }
}

/// The baseline rank a Claude alias stands for on another provider.
fn alias_baseline(alias: &str) -> Option<usize> {
    match alias {
        "opus" | "fable" => Some(0),
        "sonnet" => Some(1),
        "haiku" => Some(2),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(tiers: &[(&str, &str)], default_tier: Option<&str>) -> ProviderIdentity {
        ProviderIdentity {
            persona: "DeepSeek".into(),
            tiers: tiers.iter().map(|(n, m)| TierSpec { name: (*n).into(), model: (*m).into(), hint: None }).collect(),
            default_tier: default_tier.map(str::to_owned),
            effort_supported: false,
        }
    }

    #[test]
    fn claude_resolves_tiers_and_passes_its_aliases_through() {
        let claude = ProviderIdentity::claude();
        assert_eq!(claude.resolve_tier("high"), "opus");
        assert_eq!(claude.resolve_tier("max"), "fable");
        assert_eq!(claude.resolve_tier("sonnet"), "sonnet");
        assert_eq!(claude.resolve_tier("claude-opus-4"), "claude-opus-4");
        assert_eq!(claude.default_tier_name(), "high");
        assert!(claude.default_tier_is_valid());
    }

    #[test]
    fn another_provider_maps_claude_aliases_to_its_own_ranks() {
        let full = provider(&[("high", "v4-pro"), ("medium", "v4"), ("low", "v4-lite")], None);
        assert_eq!(full.resolve_tier("opus"), "v4-pro");
        assert_eq!(full.resolve_tier("sonnet"), "v4");
        assert_eq!(full.resolve_tier("haiku"), "v4-lite");
        assert_eq!(full.default_tier_name(), "high");

        let two = provider(&[("high", "big"), ("low", "small")], Some("low"));
        assert_eq!(two.resolve_tier("sonnet"), "big", "the stronger neighbour wins a tie");
        assert_eq!(two.default_tier_name(), "low");

        let custom = provider(&[("ultra", "u1"), ("lite", "l1")], Some("nope"));
        assert_eq!(custom.resolve_tier("haiku"), "u1", "no baseline name at all: the first tier");
        assert_eq!(custom.resolve_tier("lite"), "l1");
        assert!(!custom.default_tier_is_valid());
    }
}
