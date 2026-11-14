//! What changed in a working tree, against HEAD and against a fork point.

mod support;

use std::fs;

use eos_contracts::{ChangedFile, ChangedFileStatus};
use eos_core::git::{DiffStat, GitDiffs, GitInfo};
use eos_domain::git::changes::{PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES, attach_patches};
use support::{Dir, adapter, commit_file, git_ok, head, init_repo};

fn mutated_repo() -> Dir {
    let repo = init_repo("eos-changes-");
    repo.write("modified.txt", "one\ntwo\nthree\n");
    repo.write("deleted.txt", "bye\n");
    repo.write("renamed-old.txt", "same content here\nstable\n");
    repo.write("binary.bin", [0u8, 1, 2, 255, 0, 3]);
    git_ok(&repo.path, &["add", "-A"]);
    git_ok(&repo.path, &["commit", "-q", "-m", "init"]);
    repo.write("modified.txt", "one\nTWO\nthree\nfour\n");
    fs::remove_file(repo.join("deleted.txt")).expect("remove");
    git_ok(&repo.path, &["mv", "renamed-old.txt", "renamed-new.txt"]);
    repo.write("fresh file.txt", "hello\nworld\n");
    repo.write("binary.bin", [255u8, 254, 0, 1, 0, 9]);
    repo
}

fn find<'a>(files: &'a [ChangedFile], path: &str) -> &'a ChangedFile {
    files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} is listed"))
}

#[tokio::test]
async fn changed_files_report_each_kind_of_change() {
    let (repo, git) = (mutated_repo(), adapter());
    let files = git.changed_files(&repo.path, None).await;

    let modified = find(&files, "modified.txt");
    assert_eq!(
        (modified.status, modified.untracked, modified.insertions, modified.deletions),
        (ChangedFileStatus::M, false, Some(2), Some(1))
    );
    assert_eq!(find(&files, "deleted.txt").status, ChangedFileStatus::D);
    let renamed = find(&files, "renamed-new.txt");
    assert_eq!(
        (renamed.status, renamed.old_path.as_deref(), renamed.insertions, renamed.deletions),
        (ChangedFileStatus::R, Some("renamed-old.txt"), Some(0), Some(0))
    );
    let fresh = find(&files, "fresh file.txt");
    assert_eq!((fresh.status, fresh.untracked, fresh.insertions), (ChangedFileStatus::A, true, None));
    let binary = find(&files, "binary.bin");
    assert_eq!((binary.status, binary.insertions, binary.deletions), (ChangedFileStatus::M, None, None));
    // Sorted as the dashboard sorts.
    let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["binary.bin", "deleted.txt", "fresh file.txt", "modified.txt", "renamed-new.txt"]);
}

#[tokio::test]
async fn file_diffs_cover_tracked_untracked_binary_and_deleted_files() {
    let (repo, git) = (mutated_repo(), adapter());
    let tracked = git.file_diff(&repo.path, "modified.txt", None, None).await;
    assert!(!tracked.binary && !tracked.truncated);
    assert!(
        tracked.patch.contains("\n@@ ") && tracked.patch.contains("\n-two\n") && tracked.patch.contains("\n+TWO\n")
    );

    // An untracked file: `--no-index` exits 1 and the patch is still used.
    let untracked = git.file_diff(&repo.path, "fresh file.txt", None, None).await;
    assert!(untracked.patch.contains("\n+hello\n") && untracked.patch.contains("\n+world\n"));

    let binary = git.file_diff(&repo.path, "binary.bin", None, None).await;
    assert!(binary.binary && binary.patch.is_empty());

    assert!(git.file_diff(&repo.path, "deleted.txt", None, None).await.patch.contains("\n-bye\n"));
    assert_eq!(git.file_diff(&repo.path, "../outside.txt", None, None).await.patch, "");
}

#[tokio::test]
async fn a_folder_that_is_not_a_repository_reads_as_nothing() {
    let (dir, git) = (Dir::new("eos-norepo-"), adapter());
    assert!(git.changed_files(&dir.path, None).await.is_empty());
    assert!(!git.is_repo(&dir.path).await);
    assert!(git.log(&dir.path, 10, 0).await.is_empty());
    assert!(git.stash_list(&dir.path).await.is_empty());
    assert!(git.recent_checkouts(&dir.path).await.is_empty());
    assert_eq!(git.git_dirs(&dir.path).await, None);
    assert_eq!(git.full_diff(&dir.path, None).await, None);
    assert_eq!(git.diff_short_stat(&dir.path, None).await, DiffStat::default());
}

/// A source checkout and a worktree under `.eos/worktrees` that holds a
/// committed change, an uncommitted change and an untracked file.
fn forked() -> (Dir, std::path::PathBuf) {
    let src = init_repo("eos-base-src-");
    commit_file(&src.path, "a.txt", "one\ntwo\n", "init");
    let wt = src.join(".eos/worktrees/eos-base-w1");
    git_ok(&src.path, &["worktree", "add", "-q", wt.to_str().expect("utf-8"), "-b", "eos-base-w1"]);
    let wt = fs::canonicalize(wt).expect("real path");
    fs::write(wt.join("a.txt"), "ONE\ntwo\n").expect("write");
    git_ok(&wt, &["commit", "-aqm", "edit a"]);
    fs::write(wt.join("b.txt"), "newfile\n").expect("write");
    git_ok(&wt, &["add", "b.txt"]);
    git_ok(&wt, &["commit", "-qm", "add b"]);
    fs::write(wt.join("b.txt"), "newfile\nmore\n").expect("write");
    fs::write(wt.join("untracked.txt"), "u\n").expect("write");
    (src, wt)
}

#[tokio::test]
async fn a_base_adds_committed_work_to_the_comparison() {
    let ((src, wt), git) = (forked(), adapter());
    let base = git.merge_base(&wt, &src.path).await.expect("a fork point");
    assert_eq!(base, head(&src.path));

    assert_eq!(git.default_base_ref(&wt).await.as_deref(), Some("main"), "no remote: falls back to main");
    assert_eq!(git.merge_base_ref(&wt, "main").await.as_deref(), Some(base.as_str()));
    assert_eq!(git.merge_base_ref(&wt, "no-such-branch").await, None);

    // Against HEAD: the uncommitted edit and the untracked file only.
    assert_eq!(git.diff_short_stat(&wt, None).await.files, 2);
    let full = git.diff_short_stat(&wt, Some(&base)).await;
    assert_eq!(full.files, 3);
    assert!(full.insertions >= 3);

    let mut files = git.changed_files(&wt, Some(&base)).await;
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt", "b.txt", "untracked.txt"]);
    assert_eq!((find(&files, "a.txt").status, find(&files, "a.txt").untracked), (ChangedFileStatus::M, false));
    assert_eq!(find(&files, "b.txt").status, ChangedFileStatus::A);
    assert!(find(&files, "untracked.txt").untracked);

    let committed = git.file_diff(&wt, "a.txt", None, Some(&base)).await;
    assert!(committed.patch.contains("\n-one\n") && committed.patch.contains("\n+ONE\n"));

    // One whole-tree diff embeds the same patches a per-file request serves.
    let whole = git.full_diff(&wt, Some(&base)).await.expect("a patch");
    attach_patches(&mut files, &whole, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
    assert_eq!(find(&files, "a.txt").patch.as_deref(), Some(committed.patch.as_str()));
    assert_eq!(find(&files, "a.txt").truncated, Some(false));
    assert_eq!(find(&files, "untracked.txt").patch, None);

    // Worktrees Eos keeps inside the source are not the source's changes.
    assert_eq!(git.diff_short_stat(&src.path, None).await.files, 0);
    assert!(!git.has_uncommitted_changes(&src.path).await);
    assert!(git.has_uncommitted_changes(&wt).await);
}

#[tokio::test]
async fn a_worktree_with_only_a_new_file_is_not_clean() {
    let (src, git) = (init_repo("eos-base-src-"), adapter());
    commit_file(&src.path, "a.txt", "one\n", "init");
    let wt = src.join(".eos/worktrees/eos-base-w2");
    git_ok(&src.path, &["worktree", "add", "-q", wt.to_str().expect("utf-8"), "-b", "eos-base-w2"]);
    fs::write(wt.join("brand-new.md"), "hello\n").expect("write");
    let base = git.merge_base(&wt, &src.path).await.expect("a fork point");
    let stat = git.diff_short_stat(&wt, Some(&base)).await;
    assert_eq!((stat.files, stat.insertions), (1, 0), "line counts of an untracked file are unknown");
}

#[tokio::test]
async fn unpushed_commits_and_commit_detail_in_a_clone() {
    let (src, git) = (init_repo("eos-unpushed-src-"), adapter());
    commit_file(&src.path, "a.txt", "one\n", "init");
    assert!(git.unpushed_commits(&src.path).await.is_empty(), "no upstream reads as nothing");

    let base = Dir::new("eos-unpushed-");
    let clone = base.join("clone");
    git_ok(&src.path, &["clone", "-q", src.path.to_str().expect("utf-8"), clone.to_str().expect("utf-8")]);
    support::configure(&clone);
    commit_file(&clone, "p1.txt", "1\n", "feat: first unpushed");
    commit_file(&clone, "p2.txt", "2\n", "fix: second unpushed");

    let commits = git.unpushed_commits(&clone).await;
    assert_eq!(
        commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
        ["fix: second unpushed", "feat: first unpushed"]
    );
    assert_eq!(commits[0].author, "tester");
    assert!(commits[0].ts.as_f64() > 0.0);
    assert!(commits[0].sha.len() >= 7 && commits[0].sha.bytes().all(|b| b.is_ascii_hexdigit()));

    let detail = git.commit_detail(&clone, &commits[0].sha).await.expect("the commit");
    assert_eq!(detail.subject, "fix: second unpushed");
    assert_eq!(detail.files.len(), 1);
    assert_eq!((detail.files[0].path.as_str(), detail.insertions), ("p2.txt", 1));
    assert_eq!(git.commit_detail(&clone, "deadbeef").await, None);

    let sync = git.sync_status(&clone).await.expect("an upstream");
    assert_eq!((sync.ahead, sync.behind), (2, 0));
    let push = git.push_state(&clone).await;
    assert_eq!(
        (push.branch.as_deref(), push.remote.as_deref(), push.has_upstream, push.ahead),
        (Some("main"), Some("origin"), true, 2)
    );
}

#[tokio::test]
async fn a_repository_with_no_commit_yet_is_still_a_repository() {
    let (repo, git) = (init_repo("eos-unborn-"), adapter());
    repo.write("fresh.txt", "hello\n");
    assert!(git.is_repo(&repo.path).await);
    assert!(git.list_branches(&repo.path).await.is_empty());
    assert_eq!(git.current_branch(&repo.path).await.as_deref(), Some("main"));
    assert_eq!(git.diff_short_stat(&repo.path, None).await.files, 1);
    let files = git.changed_files(&repo.path, None).await;
    assert_eq!((files.len(), files[0].untracked, files[0].insertions), (1, true, None));
    assert_eq!(git.rev_parse(&repo.path, "HEAD").await, None);
}

#[tokio::test]
async fn git_dirs_tell_a_worktree_from_the_shared_git_folder() {
    let ((src, wt), git) = (forked(), adapter());
    let main = git.git_dirs(&src.path).await.expect("a repository");
    assert_eq!(main.toplevel, src.path);
    assert_eq!(main.git_dir, src.join(".git"));
    assert_eq!(main.common_dir, src.join(".git"));
    let linked = git.git_dirs(&wt).await.expect("a worktree");
    assert_eq!(linked.toplevel, wt);
    assert_eq!(linked.git_dir, src.join(".git/worktrees/eos-base-w1"));
    assert_eq!(linked.common_dir, src.join(".git"));
}
