//! What is kept of a forgotten note so it is not learned again (04 G24):
//! its hooks and a mark of each of its words, never its text. A new note
//! that names every hook the forgotten one named and shares most of its
//! words is the same note.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Shared words, as a share of all words, from which two notes are the same.
pub const SAME_WORDS: f64 = 0.85;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
    /// Hook ids.
    #[serde(default)]
    pub hooks: Vec<String>,
    /// The first 16 hex digits of each distinct word's SHA-256.
    #[serde(default)]
    pub words: Vec<String>,
}

fn marks(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(|w| hex::encode(Sha256::digest(w.as_bytes()))[..16].to_owned())
        .collect()
}

impl Fingerprint {
    pub fn of(text: &str, hooks: Vec<String>) -> Self {
        Self { hooks, words: marks(text).into_iter().collect() }
    }

    /// A note with `text` and hook ids `hooks` is the forgotten one again.
    pub fn matches(&self, text: &str, hooks: &[String]) -> bool {
        if self.words.is_empty() || !self.hooks.iter().all(|h| hooks.contains(h)) {
            return false;
        }
        let (mine, theirs): (BTreeSet<&str>, BTreeSet<String>) =
            (self.words.iter().map(String::as_str).collect(), marks(text));
        let shared = theirs.iter().filter(|w| mine.contains(w.as_str())).count();
        let all = mine.len() + theirs.len() - shared;
        all > 0 && shared as f64 / all as f64 >= SAME_WORDS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_lesson_with_its_hooks_matches_and_the_text_is_not_kept() {
        let print = Fingerprint::of("Run npm run lint before pushing.", vec!["mh-a".into()]);
        let kept = serde_json::to_string(&print).expect("json");
        assert!(!kept.contains("lint") && !kept.contains("pushing"), "{kept}");
        assert!(print.matches("run NPM run lint before pushing", &["mh-a".into(), "mh-b".into()]));
        assert!(!print.matches("Run npm run lint before pushing.", &["mh-b".into()]), "a hook is missing");
        assert!(!print.matches("Run the tests before merging a branch.", &["mh-a".into()]));
        assert!(!Fingerprint::default().matches("anything", &[]));
    }
}
