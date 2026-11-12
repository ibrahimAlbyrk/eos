//! Merging several workers' worktrees into a checkout, on throwaway
//! repositories (`infra/src/__tests__/ChildProcessBranchMerge.test.ts`).

mod support;

use std::path::{Path, PathBuf};

use eos_contracts::IntegrateOutcome;
use eos_core::git::{BranchMerge, MergeAllResult};
use eos_domain::WorkerBranch;
use support::{Dir, adapter, commit_file, configure, git_ok, head, write};

/// A repository with three files, `.eos/` ignored as in a real one.
fn repo() -> Dir {
    let dir = Dir::new("branch-merge-");
    git_ok(&dir.path, &["init", "-q", "-b", "main"]);
    configure(&dir.path);
    write(&dir.path, "s.txt", "l1\nl2\nl3\n");
    write(&dir.path, "a.txt", "aaa\n");
    write(&dir.path, "b.txt", "bbb\n");
    commit_file(&dir.path, ".gitignore", ".eos/\n", "init");
    dir
}

/// A worker: a worktree on its own branch with uncommitted edits (workers do not commit on their own).
fn worker(repo: &Path, name: &str, edits: &[(&str, &str)]) -> WorkerBranch {
    let worktree = repo.join(".eos").join("worktrees").join(name);
    git_ok(repo, &["worktree", "add", "-q", &worktree.to_string_lossy(), "-b", name]);
    for (file, content) in edits {
        write(&worktree, file, content);
    }
    WorkerBranch {
        repo_root: repo.to_owned(),
        worktree_dir: Some(worktree),
        branch: name.into(),
        worker_id: format!("w-{name}"),
    }
}

fn outcome_of(result: &MergeAllResult, worker_id: &str) -> Option<IntegrateOutcome> {
    result.results.iter().find(|r| r.worker_id == worker_id).map(|r| r.outcome)
}

fn status_of(repo: &Path, file: &str) -> String {
    git_ok(repo, &["status", "--porcelain"]).lines().find(|l| l.contains(file)).unwrap_or_default().to_owned()
}

fn merge_head(repo: &Path) -> PathBuf {
    repo.join(".git").join("MERGE_HEAD")
}

#[tokio::test]
async fn disjoint_workers_merge_cleanly_and_nothing_is_committed() {
    let dir = repo();
    let before = head(&dir.path);
    let w1 = worker(&dir.path, "eos-w1", &[("a.txt", "aaa\nW1\n")]);
    let w2 = worker(&dir.path, "eos-w2", &[("b.txt", "bbb\nW2\n")]);

    let result = adapter().merge_all(&dir.path, &[w1, w2]).await;

    assert!(result.ok && result.conflicted_files.is_empty(), "{result:?}");
    assert!(result.results.iter().all(|r| r.outcome == IntegrateOutcome::Merged));
    assert_eq!(result.merged_files, vec!["a.txt", "b.txt"]);
    assert_eq!((dir.read("a.txt"), dir.read("b.txt")), ("aaa\nW1\n".into(), "bbb\nW2\n".into()));
    assert!(!merge_head(&dir.path).exists(), "no merge state");
    assert_eq!(head(&dir.path), before, "nothing committed");
}

#[tokio::test]
async fn the_second_worker_on_the_same_lines_is_left_as_a_real_conflict() {
    let dir = repo();
    let w1 = worker(&dir.path, "eos-w1", &[("s.txt", "W1\nl2\nl3\n"), ("a.txt", "aaa\nW1\n")]);
    let w3 = worker(&dir.path, "eos-w3", &[("s.txt", "W3\nl2\nl3\n"), ("b.txt", "bbb\nW3\n")]);

    let result = adapter().merge_all(&dir.path, &[w1, w3]).await;

    assert!(result.ok, "{result:?}");
    assert_eq!(outcome_of(&result, "w-eos-w1"), Some(IntegrateOutcome::Merged));
    assert_eq!(outcome_of(&result, "w-eos-w3"), Some(IntegrateOutcome::Conflicted));
    assert!(result.conflicted_files.contains(&"s.txt".to_owned()));
    let s = dir.read("s.txt");
    for part in ["<<<<<<<", ">>>>>>>", "W1", "W3"] {
        assert!(s.contains(part), "{part} in {s:?}");
    }
    // The conflict view keys on git's own unmerged codes.
    assert!(status_of(&dir.path, "s.txt").starts_with("UU"), "{}", status_of(&dir.path, "s.txt"));
    assert_eq!((dir.read("a.txt"), dir.read("b.txt")), ("aaa\nW1\n".into(), "bbb\nW3\n".into()));
}

#[tokio::test]
async fn a_third_conflicting_worker_waits_behind_the_first_conflict() {
    let dir = repo();
    let w1 = worker(&dir.path, "eos-w1", &[("s.txt", "W1\nl2\nl3\n")]);
    let w3 = worker(&dir.path, "eos-w3", &[("s.txt", "W3\nl2\nl3\n")]);
    let w4 = worker(&dir.path, "eos-w4", &[("s.txt", "W4\nl2\nl3\n")]);

    let result = adapter().merge_all(&dir.path, &[w1, w3, w4]).await;

    assert_eq!(outcome_of(&result, "w-eos-w1"), Some(IntegrateOutcome::Merged));
    assert_eq!(outcome_of(&result, "w-eos-w3"), Some(IntegrateOutcome::Conflicted));
    let pending = result.results.iter().find(|r| r.worker_id == "w-eos-w4").expect("w4");
    assert_eq!(pending.outcome, IntegrateOutcome::Pending);
    assert_eq!(pending.reason.as_deref(), Some("resolve the active conflict, then re-run"));
}

#[tokio::test]
async fn a_worker_with_no_changes_is_skipped() {
    let dir = repo();
    let result = adapter().merge_all(&dir.path, &[worker(&dir.path, "eos-w0", &[])]).await;
    assert_eq!(result.results[0].outcome, IntegrateOutcome::Skipped);
    assert_eq!(result.results[0].reason.as_deref(), Some("no changes to integrate"));
    assert!(result.ok && result.conflicted_files.is_empty());
}

#[tokio::test]
async fn local_edits_to_a_file_the_merge_touches_refuse_it() {
    let dir = repo();
    dir.write("a.txt", "operator local edit\n");
    let result = adapter().merge_all(&dir.path, &[worker(&dir.path, "eos-w1", &[("a.txt", "aaa\nW1\n")])]).await;
    assert!(!result.ok);
    assert_eq!(
        result.detail.as_deref(),
        Some("checkout has local changes to: a.txt — commit or stash before integrating")
    );
    assert_eq!(dir.read("a.txt"), "operator local edit\n", "nothing overwritten");
}

#[tokio::test]
async fn work_already_in_the_checkout_merges_with_nothing_to_change() {
    let dir = repo();
    let w1 = worker(&dir.path, "eos-w1", &[("a.txt", "aaa\nW1\n")]);
    commit_file(&dir.path, "a.txt", "aaa\nW1\n", "the same change, made by hand");
    let result = adapter().merge_all(&dir.path, &[w1]).await;
    assert!(result.ok && result.merged_files.is_empty() && result.conflicted_files.is_empty(), "{result:?}");
    assert_eq!(outcome_of(&result, "w-eos-w1"), Some(IntegrateOutcome::Merged));
    assert_eq!(git_ok(&dir.path, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_gone_worktree_is_stood_for_by_its_branch_and_a_missing_branch_is_skipped() {
    let dir = repo();
    let w1 = worker(&dir.path, "eos-w1", &[("a.txt", "aaa\nW1\n")]);
    let worktree = w1.worktree_dir.clone().expect("a worktree");
    git_ok(&worktree, &["commit", "-qam", "worker commit"]);
    git_ok(&dir.path, &["worktree", "remove", "--force", &worktree.to_string_lossy()]);
    let gone = WorkerBranch { branch: "eos-nope".into(), worker_id: "w-nope".into(), ..w1.clone() };

    let result = adapter().merge_all(&dir.path, &[w1, gone]).await;

    assert!(result.ok, "{result:?}");
    assert_eq!(outcome_of(&result, "w-eos-w1"), Some(IntegrateOutcome::Merged));
    assert_eq!(outcome_of(&result, "w-nope"), Some(IntegrateOutcome::Skipped));
    assert_eq!(dir.read("a.txt"), "aaa\nW1\n");
}

#[tokio::test]
async fn a_folder_that_is_no_repository_fails_whole() {
    let dir = Dir::new("not-a-repo-");
    let result = adapter().merge_all(&dir.path, &[]).await;
    assert_eq!((result.ok, result.detail.as_deref()), (false, Some("not a git repo / no HEAD")));
}
