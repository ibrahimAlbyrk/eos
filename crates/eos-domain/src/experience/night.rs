//! The night's rules: which two notes are the same lesson (learned twice,
//! perhaps on two Macs), which lessons are one lesson learned in several
//! places, and the scope a general note takes. Both Macs reach the same
//! answer from the same notes.

use std::collections::{BTreeMap, BTreeSet};

use super::note::{NoteKind, Scope, ScopeLevel};

/// Two notes this alike in meaning, with the same hooks, are one lesson.
pub const SAME_MEANING: f64 = 0.90;
/// Lessons with the same hooks, this many or more, make one general note.
pub const GENERALIZE_FROM: usize = 3;

/// A note as the night compares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Twin<'a> {
    pub id: &'a str,
    pub kind: NoteKind,
    pub scope: &'a Scope,
    /// Its hooks, without those naming a routine or a project: those are
    /// what its scope already says.
    pub hooks: &'a BTreeSet<String>,
}

/// `(kept, closed)` when `a` and `b` are the same lesson: the same kind,
/// scope and hooks, and meanings at least [`SAME_MEANING`] alike. The smaller
/// id is kept, so every Mac keeps the same one.
pub fn same_lesson(a: &Twin<'_>, b: &Twin<'_>, meaning: f64) -> Option<(String, String)> {
    let alike = a.id != b.id && a.kind == b.kind && a.scope == b.scope && a.hooks == b.hooks;
    if !alike || meaning < SAME_MEANING {
        return None;
    }
    let (kept, closed) = if a.id < b.id { (a.id, b.id) } else { (b.id, a.id) };
    Some((kept.to_owned(), closed.to_owned()))
}

/// The ids of lessons that share a non-empty set of hooks, in groups of at
/// least [`GENERALIZE_FROM`], each group sorted.
pub fn lesson_groups(lessons: &[(String, BTreeSet<String>)]) -> Vec<Vec<String>> {
    let mut by_hooks: BTreeMap<&BTreeSet<String>, Vec<String>> = BTreeMap::new();
    for (id, hooks) in lessons.iter().filter(|(_, hooks)| !hooks.is_empty()) {
        by_hooks.entry(hooks).or_default().push(id.clone());
    }
    by_hooks
        .into_values()
        .filter(|ids| ids.len() >= GENERALIZE_FROM)
        .map(|mut ids| {
            ids.sort();
            ids
        })
        .collect()
}

/// A general note's scope: the one its lessons share, else everywhere.
pub fn general_scope(scopes: &[Scope]) -> Scope {
    match scopes.split_first() {
        Some((first, rest)) if rest.iter().all(|s| s == first) => first.clone(),
        _ => Scope { level: ScopeLevel::Everywhere, key: String::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hooks(keys: &[&str]) -> BTreeSet<String> {
        keys.iter().map(|k| (*k).to_owned()).collect()
    }

    #[test]
    fn the_same_lesson_keeps_the_smaller_id_whichever_comes_first() {
        let scope = Scope { level: ScopeLevel::Project, key: "p".into() };
        let h = hooks(&["mh-1"]);
        let a = Twin { id: "mn-b", kind: NoteKind::Lesson, scope: &scope, hooks: &h };
        let b = Twin { id: "mn-a", kind: NoteKind::Lesson, scope: &scope, hooks: &h };
        let kept = Some(("mn-a".to_owned(), "mn-b".to_owned()));
        assert_eq!(same_lesson(&a, &b, 0.95), kept);
        assert_eq!(same_lesson(&b, &a, 0.95), kept);
        assert_eq!(same_lesson(&a, &b, 0.89), None, "not alike enough");
        let other = hooks(&["mh-2"]);
        assert_eq!(same_lesson(&a, &Twin { hooks: &other, ..b.clone() }, 1.0), None, "other hooks");
        let elsewhere = Scope { level: ScopeLevel::Project, key: "q".into() };
        assert_eq!(same_lesson(&a, &Twin { scope: &elsewhere, ..b.clone() }, 1.0), None, "another scope");
        assert_eq!(same_lesson(&a, &Twin { kind: NoteKind::Fact, ..b }, 1.0), None, "another kind");
    }

    #[test]
    fn three_lessons_on_the_same_hooks_are_one_group_and_their_scope_widens_when_they_differ() {
        let lessons = vec![
            ("mn-3".to_owned(), hooks(&["mh-1", "mh-2"])),
            ("mn-1".to_owned(), hooks(&["mh-1", "mh-2"])),
            ("mn-2".to_owned(), hooks(&["mh-2", "mh-1"])),
            ("mn-4".to_owned(), hooks(&["mh-1"])),
            ("mn-5".to_owned(), hooks(&[])),
            ("mn-6".to_owned(), hooks(&[])),
            ("mn-7".to_owned(), hooks(&[])),
        ];
        assert_eq!(lesson_groups(&lessons), vec![vec!["mn-1".to_owned(), "mn-2".to_owned(), "mn-3".to_owned()]]);
        let p = Scope { level: ScopeLevel::Project, key: "p".into() };
        let q = Scope { level: ScopeLevel::Project, key: "q".into() };
        assert_eq!(general_scope(&[p.clone(), p.clone()]), p);
        assert_eq!(general_scope(&[p, q]).level, ScopeLevel::Everywhere);
    }
}
