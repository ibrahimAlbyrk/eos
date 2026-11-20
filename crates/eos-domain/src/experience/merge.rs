//! How a new note meets the notes next to it. The reflector labels the
//! neighbours it was shown; only those labels count (an id the model makes
//! up, or one it was not shown, is ignored). The same lesson again adds
//! evidence to the note that has it; an opposite one replaces it; a
//! narrower or wider one is linked as refining it.

use std::collections::HashSet;

use super::reflect::{Neighbour, Relation};

/// What one reflection writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergePlan {
    /// The lesson is known: the moment becomes evidence of that note.
    AddEvidence(String),
    /// A new note, its links to neighbours and the notes it closes.
    Insert {
        /// `(from, to, rel)`; `None` stands for the new note.
        links: Vec<(Option<String>, Option<String>, &'static str)>,
        /// Neighbours the new note replaces.
        close: Vec<String>,
    },
}

/// The plan for a new note whose reflection labelled `labelled`, of the
/// neighbours it was `shown`.
pub fn apply(labelled: &[Neighbour], shown: &HashSet<String>) -> MergePlan {
    let known: Vec<&Neighbour> = labelled.iter().filter(|n| shown.contains(&n.id)).collect();
    if let Some(same) = known.iter().find(|n| n.relation == Relation::Same) {
        return MergePlan::AddEvidence(same.id.clone());
    }
    let mut links = Vec::new();
    let mut close = Vec::new();
    for n in known {
        let other = Some(n.id.clone());
        match n.relation {
            Relation::Opposite => {
                links.push((None, other, "replaces"));
                close.push(n.id.clone());
            }
            Relation::Narrower => links.push((None, other, "refines")),
            Relation::Wider => links.push((other, None, "refines")),
            Relation::Same | Relation::Unrelated => {}
        }
    }
    MergePlan::Insert { links, close }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, relation: Relation) -> Neighbour {
        Neighbour { id: id.into(), relation }
    }

    #[test]
    fn the_same_lesson_adds_evidence_and_others_link_or_replace() {
        let shown: HashSet<String> = ["mn-a", "mn-b", "mn-c"].into_iter().map(String::from).collect();
        assert_eq!(apply(&[n("mn-b", Relation::Same)], &shown), MergePlan::AddEvidence("mn-b".into()));
        let plan =
            apply(&[n("mn-a", Relation::Opposite), n("mn-b", Relation::Narrower), n("mn-c", Relation::Wider)], &shown);
        assert_eq!(
            plan,
            MergePlan::Insert {
                links: vec![
                    (None, Some("mn-a".into()), "replaces"),
                    (None, Some("mn-b".into()), "refines"),
                    (Some("mn-c".into()), None, "refines"),
                ],
                close: vec!["mn-a".into()],
            }
        );
    }

    #[test]
    fn a_label_on_a_note_not_shown_is_ignored() {
        let shown: HashSet<String> = ["mn-a".to_owned()].into();
        let plan = apply(&[n("mn-x", Relation::Same), n("mn-y", Relation::Opposite)], &shown);
        assert_eq!(plan, MergePlan::Insert { links: vec![], close: vec![] });
    }
}
