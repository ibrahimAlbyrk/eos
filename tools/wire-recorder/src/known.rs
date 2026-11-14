//! Differences that are meant to be there.
//!
//! A target that replaces the daemon answers a few things differently on
//! purpose, or cannot answer them yet. Each such place is listed in a file
//! with its reason; a replay then fails only on a difference nobody explained.
//!
//! ```toml
//! [[known]]
//! scenario = "30-stream"            # the recording's name; `*` matches any run of characters
//! step = "*"                        # the step's name, same matching (default: every step)
//! at = "/frames/*/*/data/caps/**"   # where in the response: `*` within one segment, `**` any number
//! reason = "…"                      # (default: anywhere in the step)
//! ```

use std::path::Path;

use anyhow::Context;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    scenario: String,
    #[serde(default = "any")]
    step: String,
    #[serde(default)]
    at: Option<String>,
    reason: String,
}

fn any() -> String {
    "*".to_owned()
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    known: Vec<Entry>,
}

/// The listed differences.
#[derive(Debug, Default)]
pub struct Known {
    entries: Vec<Entry>,
}

/// `*` in `pattern` matches any run of characters.
fn name_matches(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == name,
        Some((head, tail)) => name
            .strip_prefix(head)
            .is_some_and(|rest| (0..=rest.len()).any(|i| rest.is_char_boundary(i) && name_matches(tail, &rest[i..]))),
    }
}

fn pointer_matches(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| pointer_matches(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((segment, tail)) => name_matches(first, segment) && pointer_matches(rest, tail),
            None => false,
        },
    }
}

impl Known {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let file: File = toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        Ok(Self { entries: file.known })
    }

    /// Why the difference at `pointer` in this step is expected, if it is listed.
    pub fn reason(&self, scenario: &str, step: &str, pointer: &str) -> Option<&str> {
        let path: Vec<&str> = pointer.split('/').skip(1).collect();
        self.entries
            .iter()
            .find(|e| {
                name_matches(&e.scenario, scenario)
                    && name_matches(&e.step, step)
                    && e.at
                        .as_deref()
                        .is_none_or(|at| pointer_matches(&at.split('/').skip(1).collect::<Vec<_>>(), &path))
            })
            .map(|e| e.reason.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(toml: &str) -> Known {
        Known { entries: toml::from_str::<File>(toml).expect("parses").known }
    }

    #[test]
    fn a_difference_is_known_by_scenario_step_and_place() {
        let known = known(
            r#"
            [[known]]
            scenario = "30-stream"
            at = "/frames/*/*/data/caps/**"
            reason = "no patcher yet"

            [[known]]
            scenario = "19-*"
            step = "foreign-*"
            reason = "no listener"
            "#,
        );
        assert_eq!(known.reason("30-stream", "open", "/frames/all/2/data/caps/0"), Some("no patcher yet"));
        assert_eq!(known.reason("30-stream", "open", "/frames/all/2/data/caps"), Some("no patcher yet"));
        assert_eq!(known.reason("30-stream", "open", "/frames/all/2/data/seq"), None);
        assert_eq!(known.reason("31-pages", "open", "/frames/all/2/data/caps/0"), None);
        assert_eq!(known.reason("19-cors", "foreign-origin", "/status"), Some("no listener"));
        assert_eq!(known.reason("19-cors", "same-origin", "/status"), None);
        let headers = super::pointer_matches(&["headers", "access-control-*"], &["headers", "access-control-max-age"]);
        assert!(headers, "a star matches inside a segment too");
    }

    #[test]
    fn an_unknown_key_in_the_file_is_an_error() {
        assert!(toml::from_str::<File>("[[known]]\nscenario = \"x\"\nwhy = \"typo\"").is_err());
    }
}
