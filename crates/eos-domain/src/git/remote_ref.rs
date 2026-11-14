//! Turning a remote-tracking label of the branch picker (`origin/feature/x`)
//! into the local branch to check out, so git creates a tracking branch
//! instead of detaching HEAD.

pub fn is_remote_branch(branch: &str, remotes: &[String]) -> bool {
    remotes.iter().any(|r| branch.strip_prefix(r.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

/// The branch without its remote's name. The longest matching remote wins, so
/// a remote called `orig` does not half-strip `origin/x`.
pub fn strip_remote_prefix<'a>(branch: &'a str, remotes: &[String]) -> &'a str {
    let mut by_length: Vec<&String> = remotes.iter().collect();
    by_length.sort_by_key(|r| std::cmp::Reverse(r.len()));
    by_length
        .into_iter()
        .find_map(|r| branch.strip_prefix(r.as_str()).and_then(|rest| rest.strip_prefix('/')))
        .unwrap_or(branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remotes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn tells_remote_tracking_refs_from_local_branches() {
        let r = remotes(&["origin", "upstream"]);
        assert!(is_remote_branch("origin/main", &r));
        assert!(is_remote_branch("upstream/feature/x", &r));
        assert!(!is_remote_branch("main", &r));
        assert!(!is_remote_branch("feature/x", &r));
    }

    #[test]
    fn strips_the_most_specific_remote_only() {
        let r = remotes(&["origin", "upstream"]);
        assert_eq!(strip_remote_prefix("origin/main", &r), "main");
        assert_eq!(strip_remote_prefix("origin/feature/deep/x", &r), "feature/deep/x");
        assert_eq!(strip_remote_prefix("feature/x", &r), "feature/x");
        assert_eq!(strip_remote_prefix("origin/x", &remotes(&["orig", "origin"])), "x");
    }
}
