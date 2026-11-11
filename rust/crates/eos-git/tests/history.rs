//! History, commits, blobs, stashes and the recent-branches order.

mod support;

use eos_contracts::{ChangedFile, ChangedFileStatus};
use eos_core::git::{GitDiffs, GitInfo, OpResult, WorkingTree};
use eos_domain::git::changes::{PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES, attach_patches};
use support::{Dir, adapter, commit_file, git_ok, head, init_repo};

#[tokio::test]
async fn log_pages_through_history_and_rev_parse_resolves() {
    let (repo, git) = (init_repo("eos-scope-"), adapter());
    for n in 1..=3 {
        commit_file(&repo.path, "f.txt", &format!("line {n}\n"), &format!("c{n}"));
    }
    // limit + 1 rows: the extra one only says there is more.
    let rows = git.log(&repo.path, 2, 0).await;
    assert_eq!(rows.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["c3", "c2", "c1"]);
    assert_eq!(git.log(&repo.path, 2, 2).await.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["c1"]);

    let short = git.rev_parse(&repo.path, "HEAD").await.expect("a sha");
    assert!(short.len() >= 4 && head(&repo.path).starts_with(&short));
    assert_eq!(git.rev_parse(&repo.path, "deadbeefdeadbeef").await, None);
}

fn file(path: &str) -> ChangedFile {
    ChangedFile {
        path: path.into(),
        old_path: None,
        status: ChangedFileStatus::M,
        insertions: Some(1),
        deletions: Some(1),
        untracked: false,
        patch: None,
        binary: None,
        truncated: None,
    }
}

#[tokio::test]
async fn a_commit_gives_its_patch_its_files_and_its_blobs() {
    let (repo, git) = (init_repo("eos-cpatch-"), adapter());
    repo.write("a.txt", "alpha\n");
    commit_file(&repo.path, "b.txt", "bravo\n", "init");
    repo.write("a.txt", "alpha changed\n");
    commit_file(&repo.path, "b.txt", "bravo changed\n", "touch both");
    let sha = head(&repo.path);

    let full = git.commit_patch(&repo.path, &sha).await.expect("a patch");
    let mut files = [file("a.txt"), file("b.txt")];
    attach_patches(&mut files, &full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
    let (a, b) = (files[0].patch.clone().expect("a"), files[1].patch.clone().expect("b"));
    assert!(a.contains("\n+alpha changed\n") && !a.contains("bravo"));
    assert!(b.contains("\n+bravo changed\n") && !b.contains("alpha"));
    assert_eq!(git.commit_patch(&repo.path, "deadbeefdeadbeef").await, None);

    let one = git.commit_file_diff(&repo.path, &sha, "a.txt", None).await;
    assert!(!one.binary && one.patch.contains("\n-alpha\n") && one.patch.contains("\n+alpha changed\n"));
    assert!(!one.patch.contains("bravo"));
    let none = git.commit_file_diff(&repo.path, "deadbeefdeadbeef", "a.txt", None).await;
    assert_eq!((none.path.as_str(), none.patch.as_str(), none.binary, none.truncated), ("a.txt", "", false, false));

    let detail = git.commit_detail(&repo.path, &sha).await.expect("the commit");
    assert_eq!(detail.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt", "b.txt"]);
    assert_eq!((detail.insertions, detail.deletions, detail.body.as_str()), (2, 2, ""));

    assert_eq!(git.blob_size_at_ref(&repo.path, &sha, "a.txt").await, Some("alpha changed\n".len() as u64));
    assert_eq!(git.blob_at_ref(&repo.path, &sha, "a.txt").await.as_deref(), Some(b"alpha changed\n".as_slice()));
    assert_eq!(git.blob_size_at_ref(&repo.path, &sha, "nope.txt").await, None);
    assert_eq!(git.blob_at_ref(&repo.path, &sha, "nope.txt").await, None);
}

// A stash is a merge commit; shown plainly it would read as an empty diff.
#[tokio::test]
async fn a_stash_reads_as_the_change_that_was_stashed() {
    let (repo, git) = (init_repo("eos-stash-"), adapter());
    commit_file(&repo.path, "tracked.txt", "one\n", "init");
    repo.write("tracked.txt", "one\ntwo\n");
    repo.write("untracked.txt", "brand new\n");
    git_ok(&repo.path, &["stash", "push", "-u", "-m", "my work"]);
    let stash = git_ok(&repo.path, &["rev-parse", "--short", "stash@{0}"]).trim().to_owned();

    let stashes = git.stash_list(&repo.path).await;
    assert_eq!(stashes.len(), 1);
    assert_eq!((stashes[0].index, stashes[0].branch.as_deref()), (0, Some("main")));
    assert!(stashes[0].subject.contains("my work") && stashes[0].sha.len() >= 4 && stashes[0].ts.as_f64() > 0.0);
    assert_eq!(git.stash_count(&repo.path).await, 1);

    let detail = git.commit_detail(&repo.path, &stash).await.expect("the stash commit");
    assert!(detail.files.iter().any(|f| f.path == "tracked.txt") && detail.insertions >= 1);
    let patch = git.commit_patch(&repo.path, &stash).await.expect("a patch");
    assert!(patch.contains("\n+two\n") && patch.contains("diff --git a/tracked.txt"));
    let one = git.commit_file_diff(&repo.path, &stash, "tracked.txt", None).await;
    assert!(one.patch.contains("\n+two\n") && !one.patch.contains("brand new"));

    let first_parent = git.rev_parse(&repo.path, &format!("{stash}^")).await;
    assert_eq!(
        first_parent.as_deref(),
        Some(git_ok(&repo.path, &["rev-parse", "--short", &format!("{stash}^1")]).trim())
    );
}

fn repo_with_stash() -> Dir {
    let repo = init_repo("eos-stashmut-");
    commit_file(&repo.path, "f.txt", "base\n", "init");
    repo.write("f.txt", "stashed\n");
    git_ok(&repo.path, &["stash", "push", "-m", "work"]);
    repo
}

#[tokio::test]
async fn applying_a_stash_keeps_it_and_dropping_removes_it() {
    let (repo, git) = (repo_with_stash(), adapter());
    assert_eq!(git.stash_apply(&repo.path, 0).await, OpResult::ok());
    assert_eq!(repo.read("f.txt"), "stashed\n");
    assert_eq!(git.stash_list(&repo.path).await.len(), 1);

    assert_eq!(git.stash_drop(&repo.path, 0).await, OpResult::ok());
    assert!(git.stash_list(&repo.path).await.is_empty());
    assert_eq!(git.stash_count(&repo.path).await, 0);
}

#[tokio::test]
async fn a_stash_that_cannot_apply_or_does_not_exist_reports_gits_message() {
    let (repo, git) = (repo_with_stash(), adapter());
    repo.write("f.txt", "working divergent\n");
    let conflict = git.stash_apply(&repo.path, 0).await;
    assert!(!conflict.ok && conflict.error.is_some_and(|e| !e.is_empty()));
    let missing = git.stash_drop(&repo.path, 99).await;
    assert!(!missing.ok && missing.error.is_some_and(|e| !e.is_empty()));
}

#[tokio::test]
async fn recent_checkouts_are_most_recent_first() {
    let (repo, git) = (init_repo("eos-recent-"), adapter());
    commit_file(&repo.path, "a.txt", "x\n", "init");
    assert!(git.recent_checkouts(&repo.path).await.is_empty(), "a fresh repository has none");
    git_ok(&repo.path, &["branch", "feature-a"]);
    git_ok(&repo.path, &["branch", "feature-b"]);
    for branch in ["feature-a", "feature-b", "main", "feature-a"] {
        git_ok(&repo.path, &["checkout", "-q", branch]);
    }
    assert_eq!(git.recent_checkouts(&repo.path).await, ["feature-a", "main", "feature-b"]);
    assert_eq!(git.current_branch(&repo.path).await.as_deref(), Some("feature-a"));
    assert_eq!(git.list_branches(&repo.path).await, ["feature-a", "feature-b", "main"]);
}

#[tokio::test]
async fn checkout_and_stash_push_fail_with_the_command_and_gits_words() {
    let (repo, git) = (init_repo("eos-checkout-"), adapter());
    commit_file(&repo.path, "a.txt", "x\n", "init");
    let failed = git.checkout(&repo.path, "nope").await.expect_err("no such branch");
    let cwd = repo.path.display();
    assert!(failed.0.starts_with(&format!("Command failed: git -C {cwd} checkout nope\n")), "{}", failed.0);
    assert!(failed.0.contains("error: pathspec 'nope' did not match"));
    assert_eq!(git.stash_push(&repo.path).await, Ok(()), "nothing to stash is not a failure");
    git_ok(&repo.path, &["branch", "other"]);
    assert_eq!(git.checkout(&repo.path, "other").await, Ok(()));
}
