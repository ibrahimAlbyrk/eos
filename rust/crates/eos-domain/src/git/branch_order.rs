//! The branch picker's order.

use std::collections::HashMap;

use crate::text::locale_compare;

/// Most recently used first (`usage` is newest first), then the rest in
/// alphabetical order. A current branch that `usage` has not seen (a fresh
/// worktree with an empty reflog) counts as the most recent.
pub fn order_branches(branches: &[String], usage: &[String], current: Option<&str>) -> Vec<String> {
    let mut rank: HashMap<&str, i64> = HashMap::new();
    for (i, name) in usage.iter().enumerate() {
        rank.entry(name.as_str()).or_insert(i as i64);
    }
    if let Some(current) = current.filter(|c| !c.is_empty()) {
        rank.entry(current).or_insert(-1);
    }
    let rank_of = |name: &str| rank.get(name).copied().unwrap_or(i64::MAX);
    let mut ordered = branches.to_vec();
    ordered.sort_by(|a, b| rank_of(a).cmp(&rank_of(b)).then_with(|| locale_compare(a, b)));
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(branches: &[&str], usage: &[&str], current: Option<&str>) -> Vec<String> {
        let owned = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        order_branches(&owned(branches), &owned(usage), current)
    }

    #[test]
    fn orders_by_most_recent_use() {
        assert_eq!(
            order(&["feature-b", "main", "feature-a"], &["feature-a", "main", "feature-b"], Some("feature-a")),
            ["feature-a", "main", "feature-b"]
        );
    }

    #[test]
    fn unused_branches_follow_in_alphabetical_order() {
        assert_eq!(
            order(&["zzz", "main", "aaa", "feature"], &["main", "feature"], Some("main")),
            ["main", "feature", "aaa", "zzz"]
        );
        assert_eq!(order(&["main", "dev", "release", "alpha"], &[], None), ["alpha", "dev", "main", "release"]);
    }

    #[test]
    fn the_current_branch_is_never_buried() {
        assert_eq!(
            order(&["main", "dev", "feature-new"], &["main", "dev"], Some("feature-new")),
            ["feature-new", "main", "dev"]
        );
    }

    #[test]
    fn deleted_and_repeated_usage_entries_do_no_harm() {
        assert_eq!(order(&["main", "dev"], &["deleted-branch", "dev", "main"], Some("dev")), ["dev", "main"]);
        assert_eq!(order(&["a", "b", "c"], &["c", "a", "c", "b"], None), ["c", "a", "b"]);
    }
}
