//! Branch operations that add a rule to a git command: checking out by a
//! picker label, and validating a name before creating or renaming.

use std::path::Path;

use eos_contracts::{BranchOpResponse, FsCheckoutResponse};
use eos_core::git::{BranchAdmin, GitInfo, WorkingTree};
use eos_domain::git::branch_name::validate_branch_name;
use eos_domain::git::remote_ref::strip_remote_prefix;

/// The line of a failed git command that says what went wrong, without the
/// `error:` / `fatal:` prefix: never the echoed command line when git said more.
fn clean_git_error(message: &str) -> String {
    let lower_starts =
        |line: &str, prefix: &str| line.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix));
    let telling = message.split('\n').map(str::trim).find(|l| lower_starts(l, "error:") || lower_starts(l, "fatal:"));
    let line = telling.unwrap_or_else(|| message.split('\n').next().unwrap_or("Checkout failed"));
    for prefix in ["error:", "fatal:"] {
        if lower_starts(line, prefix) {
            return line[prefix.len()..].trim_start().to_owned();
        }
    }
    line.to_owned()
}

/// Uncommitted changes are what stops the switch.
fn is_dirty_block(message: &str) -> bool {
    let message = message.to_lowercase();
    ["would be overwritten", "commit your changes or stash", "please commit"].iter().any(|said| message.contains(said))
}

/// Checks out a branch by the label the picker shows. A remote-tracking label
/// (`origin/x`) is checked out by its short name, so git creates a local
/// tracking branch instead of detaching HEAD.
///
/// Uncommitted changes in the way come back as `dirty`, so the dashboard can
/// offer "Stash & switch" — which calls again with `stash`.
pub(crate) async fn checkout_branch(
    git: &dyn GitInfo,
    tree: &dyn WorkingTree,
    cwd: &Path,
    label: &str,
    stash: bool,
) -> FsCheckoutResponse {
    let failed = |error: String| FsCheckoutResponse { ok: false, dirty: None, error: Some(error) };
    let remotes = git.remotes(cwd).await;
    let target = strip_remote_prefix(label, &remotes);
    if stash && let Err(e) = tree.stash_push(cwd).await {
        return failed(clean_git_error(&e.0));
    }
    match tree.checkout(cwd, target).await {
        Ok(()) => FsCheckoutResponse { ok: true, dirty: None, error: None },
        Err(e) if !stash && is_dirty_block(&e.0) => FsCheckoutResponse { ok: false, dirty: Some(true), error: None },
        Err(e) => failed(clean_git_error(&e.0)),
    }
}

fn refused(reason: &str) -> BranchOpResponse {
    BranchOpResponse { ok: false, branch: None, error: Some(reason.to_owned()) }
}

/// Creates a branch (switching to it unless told otherwise) once its name passes.
pub(crate) async fn create_branch(
    branches: &dyn BranchAdmin,
    cwd: &Path,
    name: &str,
    start_point: Option<&str>,
    checkout: Option<bool>,
) -> BranchOpResponse {
    match validate_branch_name(name) {
        Err(reason) => refused(reason),
        Ok(()) => {
            branches.create(cwd, name.trim(), start_point.filter(|s| !s.is_empty()), checkout.unwrap_or(true)).await
        }
    }
}

/// Renames a branch once the new name passes. Renaming the current branch is fine.
pub(crate) async fn rename_branch(branches: &dyn BranchAdmin, cwd: &Path, from: &str, to: &str) -> BranchOpResponse {
    match validate_branch_name(to) {
        Err(reason) => refused(reason),
        Ok(()) => branches.rename(cwd, from, to.trim()).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_git_failure_is_reduced_to_the_line_that_matters() {
        let echoed = "Command failed: git -C /r checkout x\nfatal: invalid reference: x";
        assert_eq!(clean_git_error(echoed), "invalid reference: x");
        assert_eq!(clean_git_error("Command failed: git -C /r checkout x"), "Command failed: git -C /r checkout x");
        assert_eq!(clean_git_error("  ERROR: pathspec 'x' did not match\nhint: y"), "pathspec 'x' did not match");
    }

    #[test]
    fn local_changes_in_the_way_are_recognized() {
        let dirty = "Command failed: git -C /r checkout x\nerror: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting";
        assert!(is_dirty_block(dirty));
        assert!(!is_dirty_block("fatal: invalid reference: x"));
    }
}
