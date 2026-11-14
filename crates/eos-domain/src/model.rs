//! Which catalog entry a model name means, and how large its context window is.

use eos_contracts::CatalogModel;

/// The window of a model nobody knows.
const CONTEXT_WINDOW_FALLBACK: i64 = 200_000;

/// The window a model gets when the catalog is empty or does not list it:
/// Claude families carry the 1M window (the dashboard's own baseline agrees,
/// `app/ui/src/lib/models.js`).
fn baseline_window_for(model: &str) -> i64 {
    let lower = model.to_lowercase();
    if ["haiku", "sonnet", "opus", "fable"].iter().any(|family| lower.contains(family)) {
        1_000_000
    } else {
        CONTEXT_WINDOW_FALLBACK
    }
}

/// The newest of `models` by creation date; among equals, the first listed.
fn newest<'m>(models: impl Iterator<Item = &'m CatalogModel>) -> Option<&'m CatalogModel> {
    models.fold(None, |best: Option<&CatalogModel>, m| match best {
        Some(b) if b.created_at >= m.created_at => Some(b),
        _ => Some(m),
    })
}

/// Maps the model names in use — family aliases (`opus`), exact ids, dated
/// variants — onto a catalog entry. A family alias means its newest member,
/// as the `claude` program resolves it.
pub fn resolve_catalog_model<'m>(models: &'m [CatalogModel], raw: &str) -> Option<&'m CatalogModel> {
    if let Some(exact) = models.iter().find(|m| m.id == raw) {
        return Some(exact);
    }
    let family = format!("claude-{raw}-");
    newest(models.iter().filter(|m| m.id.starts_with(&family)))
        .or_else(|| newest(models.iter().filter(|m| m.id.starts_with(raw))))
}

/// The model's context window in tokens: the catalog's figure, else the baseline.
pub fn context_window_for(models: &[CatalogModel], model: Option<&str>) -> i64 {
    let Some(model) = model.filter(|m| !m.is_empty()) else { return CONTEXT_WINDOW_FALLBACK };
    resolve_catalog_model(models, model).and_then(|m| m.max_input_tokens).unwrap_or_else(|| baseline_window_for(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, created_at: &str, window: Option<i64>) -> CatalogModel {
        CatalogModel {
            id: id.into(),
            display_name: id.into(),
            created_at: created_at.into(),
            max_input_tokens: window,
            max_tokens: None,
            effort_levels: None,
        }
    }

    #[test]
    fn names_resolve_to_exact_ids_then_the_newest_of_a_family() {
        let models = [
            model("claude-opus-5-5", "2026-05-01", Some(1_000_000)),
            model("claude-opus-5-1", "2026-01-01", Some(500_000)),
            model("claude-sonnet-5-5-20260401", "2026-04-01", Some(900_000)),
            model("claude-sonnet-5-5-20260201", "2026-02-01", None),
        ];
        let id = |raw: &str| resolve_catalog_model(&models, raw).map(|m| m.id.as_str());
        assert_eq!(id("claude-opus-5-1"), Some("claude-opus-5-1"));
        assert_eq!(id("opus"), Some("claude-opus-5-5"));
        assert_eq!(id("claude-sonnet-5-5"), Some("claude-sonnet-5-5-20260401"));
        assert_eq!(id("gpt"), None);

        assert_eq!(context_window_for(&models, Some("opus")), 1_000_000);
        assert_eq!(context_window_for(&models, Some("claude-opus-5-1")), 500_000);
        assert_eq!(
            context_window_for(&models, Some("claude-sonnet-5-5-20260201")),
            1_000_000,
            "no figure: the baseline"
        );
    }

    #[test]
    fn an_empty_catalog_falls_back_to_the_baseline() {
        assert_eq!(context_window_for(&[], Some("opus")), 1_000_000);
        assert_eq!(context_window_for(&[], Some("Claude-Haiku-5")), 1_000_000);
        assert_eq!(context_window_for(&[], Some("deepseek-chat")), 200_000);
        assert_eq!(context_window_for(&[], None), 200_000);
        assert_eq!(context_window_for(&[], Some("")), 200_000);
    }
}
