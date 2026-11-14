//! The reasoning effort a model can take.

use eos_contracts::EFFORT_LEVELS;

/// `requested` as the model can apply it. `supported: None` means the
/// catalog does not know the model: the request passes unchanged. A level
/// the model lacks falls to the nearest lower one, else the nearest higher;
/// a model that takes no effort gets none.
pub fn resolve_effort(requested: Option<&str>, supported: Option<&[String]>) -> Option<String> {
    let requested = requested.filter(|r| !r.is_empty())?;
    let Some(at) = EFFORT_LEVELS.iter().position(|l| *l == requested) else { return Some(requested.to_owned()) };
    let Some(supported) = supported else { return Some(requested.to_owned()) };
    let has = |level: &str| supported.iter().any(|s| s == level);
    if has(requested) {
        return Some(requested.to_owned());
    }
    let lower = EFFORT_LEVELS[..at].iter().rev().find(|l| has(l));
    let higher = EFFORT_LEVELS[at + 1..].iter().find(|l| has(l));
    lower.or(higher).map(|l| (*l).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_effort_is_clamped_to_what_the_model_takes() {
        let levels = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
        assert_eq!(resolve_effort(Some("xhigh"), None).as_deref(), Some("xhigh"));
        assert_eq!(resolve_effort(Some("xhigh"), Some(&levels(&["low", "medium", "high"]))).as_deref(), Some("high"));
        assert_eq!(resolve_effort(Some("low"), Some(&levels(&["high", "max"]))).as_deref(), Some("high"));
        assert_eq!(resolve_effort(Some("high"), Some(&levels(&[]))), None, "a model with no effort");
        assert_eq!(
            resolve_effort(Some("turbo"), Some(&levels(&["low"]))).as_deref(),
            Some("turbo"),
            "not ours to judge"
        );
        assert_eq!(resolve_effort(None, None), None);
    }
}
