//! Which events a stream carries: its topic list and its tab's focus.

use std::collections::HashSet;

use crate::bus::{Scope, ScopeKind};

/// The `?topics=` filter: exact names (`worker:change`) and families (`worker:*`).
#[derive(Debug, Default)]
pub(super) struct Wants {
    exact: Vec<Box<str>>,
    /// Family prefixes, colon included (`worker:`).
    families: Vec<Box<str>>,
}

impl Wants {
    /// No list, or an empty one, means every topic.
    pub(super) fn new(topics: Option<&[String]>) -> Self {
        let mut wants = Self::default();
        for topic in topics.unwrap_or_default() {
            match topic.strip_suffix('*').filter(|prefix| prefix.ends_with(':')) {
                Some(prefix) => wants.families.push(prefix.into()),
                None => wants.exact.push(topic.as_str().into()),
            }
        }
        wants
    }

    pub(super) fn topic(&self, topic: &str) -> bool {
        (self.exact.is_empty() && self.families.is_empty())
            || self.exact.iter().any(|t| t.as_ref() == topic)
            || self.families.iter().any(|f| topic.starts_with(f.as_ref()))
    }
}

/// What a dashboard tab has on screen. Its streams then carry the
/// high-volume scoped topics only for these workers and terminals.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamFocus {
    pub workers: Vec<String>,
    pub ptys: Vec<String>,
}

#[derive(Debug)]
pub(super) struct Focus {
    workers: HashSet<Box<str>>,
    ptys: HashSet<Box<str>>,
    /// When it was last set: the oldest is forgotten first.
    pub(super) stamp: u64,
}

impl Focus {
    pub(super) fn new(focus: &StreamFocus, stamp: u64) -> Self {
        Self {
            workers: focus.workers.iter().map(|w| w.as_str().into()).collect(),
            ptys: focus.ptys.iter().map(|p| p.as_str().into()).collect(),
            stamp,
        }
    }

    pub(super) fn shows(&self, scope: &Scope) -> bool {
        match scope.kind {
            ScopeKind::Worker => self.workers.contains(scope.id.as_ref()),
            ScopeKind::Pty => self.ptys.contains(scope.id.as_ref()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_by_topic_and_family() {
        let wants = Wants::new(Some(&["worker:*".into(), "notification:fire".into()]));
        assert!(wants.topic("worker:change"));
        assert!(wants.topic("worker:exit"));
        assert!(wants.topic("notification:fire"));
        assert!(!wants.topic("pty:data"));
        assert!(!wants.topic("workers"));
        assert!(Wants::new(None).topic("anything"));
        assert!(Wants::new(Some(&[])).topic("anything"));
    }
}
