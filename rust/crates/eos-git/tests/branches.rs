//! Local branches, remotes over a bare repository on disk, restores and conflicts.

mod support;

use std::fs;

use eos_contracts::ConflictKind;
use eos_core::git::{
    BranchAdmin, BranchPush, ConflictEntry, ConflictResolution, ConflictSide, GitDiffs, GitInfo, RemoteSync,
    WorkingTreeRestore,
};
use eos_domain::git::pull_plan::PullExecReason;
use eos_domain::git::push_plan::{PushExecReason, PushKind, PushTarget};
use support::{Dir, adapter, commit_file, configure, git, git_ok, init_repo};

#[tokio::test]
async fn branches_are_created_renamed_and_deleted() {
    let (repo, admin) = (init_repo("eos-branch-"), adapter());
    commit_file(&repo.path, "a.txt", "one\n", "init");

    let made = admin.create(&repo.path, "feature/x", None, true).await;
    assert_eq!((made.ok, made.branch.as_deref()), (true, Some("feature/x")));
    assert_eq!(admin.current_branch(&repo.path).await.as_deref(), Some("feature/x"));

    let quiet = admin.create(&repo.path, "side", Some("main"), false).await;
    assert!(quiet.ok);
    assert_eq!(admin.current_branch(&repo.path).await.as_deref(), Some("feature/x"), "created without switching");

    let duplicate = admin.create(&repo.path, "side", None, false).await;
    assert_eq!(duplicate.error.as_deref(), Some("fatal: a branch named 'side' already exists"));

    let renamed = admin.rename(&repo.path, "side", "side-2").await;
    assert_eq!((renamed.ok, renamed.branch.as_deref()), (true, Some("side-2")));
    assert!(admin.list_branches(&repo.path).await.contains(&"side-2".to_owned()));

    let deleted = admin.remove(&repo.path, "side-2", false).await;
    assert_eq!((deleted.ok, deleted.deleted), (true, Some(true)));

    // A branch with its own commit is refused without force, and says why.
    commit_file(&repo.path, "b.txt", "two\n", "on feature");
    git_ok(&repo.path, &["checkout", "-q", "main"]);
    let refused = admin.remove(&repo.path, "feature/x", false).await;
    assert_eq!((refused.ok, refused.not_merged), (false, Some(true)));
    assert!(refused.error.is_some_and(|e| e.contains("not fully merged")));
    assert!(admin.remove(&repo.path, "feature/x", true).await.ok);
}

/// A bare repository and two clones of it, `a` pushed and tracking.
fn remote_pair() -> (Dir, Dir, Dir) {
    let bare = Dir::new("eos-bare-");
    git_ok(&bare.path, &["init", "-q", "--bare", "-b", "main"]);
    let a = init_repo("eos-remote-a-");
    git_ok(&a.path, &["remote", "add", "origin", bare.path.to_str().expect("utf-8")]);
    commit_file(&a.path, "a.txt", "one\n", "one");
    git_ok(&a.path, &["push", "-q", "-u", "origin", "main"]);
    let b = init_repo("eos-remote-b-");
    git_ok(&b.path, &["remote", "add", "origin", bare.path.to_str().expect("utf-8")]);
    git_ok(&b.path, &["fetch", "-q", "origin"]);
    git_ok(&b.path, &["checkout", "-q", "main"]);
    configure(&b.path);
    (bare, a, b)
}

#[tokio::test]
async fn fetch_pull_push_and_remote_branch_delete() {
    let ((_bare, a, b), git) = (remote_pair(), adapter());
    assert_eq!(git.remotes(&a.path).await, ["origin"]);
    let remote = git.remote_branches(&a.path).await;
    assert!(remote.contains(&"origin/main".to_owned()) && !remote.iter().any(|r| r.ends_with("/HEAD")));
    let state = git.pull_state(&a.path).await;
    assert_eq!((state.branch.as_deref(), state.has_upstream, state.behind), (Some("main"), true, 0));

    // `b` moves the remote on; `a` is then strictly behind.
    commit_file(&b.path, "b.txt", "two\n", "two");
    git_ok(&b.path, &["push", "-q", "origin", "main"]);
    let fetched = git.fetch(&a.path, None, true).await;
    assert_eq!((fetched.ok, fetched.summary.as_deref()), (true, Some("Fetched all remotes")));
    assert_eq!(git.fetch(&a.path, Some("origin"), false).await.summary.as_deref(), Some("Fetched origin"));
    let behind = git.pull_state(&a.path).await;
    assert_eq!((behind.behind, behind.ahead), (1, 0));
    let pulled = git.pull(&a.path).await;
    assert_eq!((pulled.ok, pulled.code, pulled.reason), (true, 0, PullExecReason::Pulled));
    assert_eq!(git.pull_state(&a.path).await.behind, 0);

    // A push that was decided elsewhere.
    commit_file(&a.path, "c.txt", "three\n", "three");
    let target = PushTarget { kind: PushKind::FastForward, remote: "origin".into(), branch: "main".into() };
    let pushed = git.push(&a.path, &target).await;
    assert_eq!((pushed.ok, pushed.reason), (true, PushExecReason::Pushed));
    let nowhere = PushTarget { kind: PushKind::FastForward, remote: "nowhere".into(), branch: "main".into() };
    let failed = git.push(&a.path, &nowhere).await;
    assert!(!failed.ok && failed.code != 0 && !failed.stderr.is_empty());

    git_ok(&a.path, &["push", "-q", "origin", "main:throwaway"]);
    git.fetch(&a.path, None, false).await;
    assert!(git.remote_branches(&a.path).await.contains(&"origin/throwaway".to_owned()));
    assert!(git.delete_remote_branch(&a.path, "origin", "throwaway").await.ok);
    git.fetch(&a.path, None, true).await;
    assert!(!git.remote_branches(&a.path).await.contains(&"origin/throwaway".to_owned()));
    let gone = git.delete_remote_branch(&a.path, "nowhere", "x").await;
    assert_eq!(gone.error.as_deref(), Some("fatal: 'nowhere' does not appear to be a git repository"));
}

#[tokio::test]
async fn a_fetch_without_remotes_succeeds_and_a_non_repository_fails() {
    let (repo, plain, git) = (init_repo("eos-noremote-"), Dir::new("eos-plain-"), adapter());
    assert!(git.fetch(&repo.path, None, true).await.ok);
    let failed = git.fetch(&plain.path, None, true).await;
    assert!(!failed.ok && failed.error.is_some_and(|e| e.starts_with("fatal: not a git repository")));
    assert_eq!(git.remote_url(&repo.path).await, None);
    git_ok(&repo.path, &["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    assert_eq!(git.remote_url(&repo.path).await.as_deref(), Some("https://github.com/owner/repo"));
}

#[tokio::test]
async fn changes_are_discarded_back_to_a_base() {
    let (repo, git) = (init_repo("eos-restore-"), adapter());
    repo.write("keep.txt", "keep\n");
    repo.write("mod.txt", "original\n");
    commit_file(&repo.path, "gone.txt", "bye\n", "init");
    let paths = |names: &[&str]| names.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();

    repo.write("mod.txt", "changed\n");
    git_ok(&repo.path, &["add", "mod.txt"]);
    assert!(git.restore_to_base(&repo.path, &paths(&["mod.txt"]), None).await.ok);
    assert_eq!(repo.read("mod.txt"), "original\n");

    fs::remove_file(repo.join("gone.txt")).expect("remove");
    assert!(git.restore_to_base(&repo.path, &paths(&["gone.txt"]), None).await.ok);
    assert_eq!(repo.read("gone.txt"), "bye\n");

    // A staged new file does not exist at the base: it is removed.
    repo.write("staged-new.txt", "new\n");
    git_ok(&repo.path, &["add", "staged-new.txt"]);
    assert!(git.restore_to_base(&repo.path, &paths(&["staged-new.txt"]), None).await.ok);
    assert!(!repo.join("staged-new.txt").exists());

    // A rename: both paths in one call bring the original back.
    git_ok(&repo.path, &["mv", "keep.txt", "moved.txt"]);
    assert!(git.restore_to_base(&repo.path, &paths(&["moved.txt", "keep.txt"]), None).await.ok);
    assert!(repo.join("keep.txt").exists() && !repo.join("moved.txt").exists());

    repo.write("untracked.txt", "u\n");
    assert!(git.remove_untracked(&repo.path, &paths(&["untracked.txt"])).await.ok);
    assert!(!repo.join("untracked.txt").exists());

    // An explicit base reaches across a later commit and leaves other files alone.
    let base = support::head(&repo.path);
    commit_file(&repo.path, "mod.txt", "second\n", "second");
    repo.write("keep.txt", "edited\n");
    assert!(git.restore_to_base(&repo.path, &paths(&["mod.txt"]), Some(&base)).await.ok);
    assert_eq!((repo.read("mod.txt").as_str(), repo.read("keep.txt").as_str()), ("original\n", "edited\n"));

    let failed = git.restore_to_base(&repo.path, &paths(&["no-such-file.txt"]), None).await;
    assert!(!failed.ok && failed.error.is_some_and(|e| !e.is_empty()));
    assert!(git.restore_to_base(&repo.path, &[], None).await.ok, "nothing to restore is a success");
}

fn try_merge(repo: &std::path::Path, branch: &str) {
    let (code, out) = git(repo, &["merge", "--no-edit", branch]);
    assert_ne!(code, 0, "the merge was meant to conflict: {out}");
}

#[tokio::test]
async fn a_content_conflict_is_listed_read_and_resolved() {
    let (repo, git) = (init_repo("eos-conflict-"), adapter());
    repo.write("f.txt", "a\nb\nc\n");
    commit_file(&repo.path, "g.txt", "g1\n", "init");
    git_ok(&repo.path, &["checkout", "-q", "-b", "feat"]);
    repo.write("f.txt", "a\nX\nc\n");
    git_ok(&repo.path, &["commit", "-qam", "feat"]);
    git_ok(&repo.path, &["checkout", "-q", "main"]);
    repo.write("f.txt", "a\nY\nc\n");
    git_ok(&repo.path, &["commit", "-qam", "main"]);
    try_merge(&repo.path, "feat");

    assert_eq!(git.conflict_list(&repo.path).await, [ConflictEntry { path: "f.txt".into(), xy: "UU".into() }]);
    assert_eq!(git.conflict_count(&repo.path).await, 1);
    let content = git.conflict_file_content(&repo.path, "f.txt").await;
    assert!(content.contains("<<<<<<<") && content.contains(">>>>>>>"));
    assert_eq!(git.stage_content(&repo.path, "f.txt", 2).await.as_deref(), Some("a\nY\nc\n"), "ours");
    assert_eq!(git.stage_content(&repo.path, "f.txt", 3).await.as_deref(), Some("a\nX\nc\n"), "theirs");
    assert_eq!(git.conflict_file_content(&repo.path, "missing.txt").await, "");

    git.write_resolved(&repo.path, "f.txt", "a\nMERGED\nc\n").await.expect("resolved");
    assert_eq!(repo.read("f.txt"), "a\nMERGED\nc\n");
    assert_eq!(git.conflict_count(&repo.path).await, 0);
    assert!(git_ok(&repo.path, &["status", "--porcelain", "f.txt"]).starts_with('M'));
}

#[tokio::test]
async fn a_delete_conflict_takes_one_side() {
    let (repo, git) = (init_repo("eos-conflict-"), adapter());
    commit_file(&repo.path, "g.txt", "g1\n", "init");
    git_ok(&repo.path, &["checkout", "-q", "-b", "feat2"]);
    git_ok(&repo.path, &["rm", "-q", "g.txt"]);
    git_ok(&repo.path, &["commit", "-qm", "delete g"]);
    git_ok(&repo.path, &["checkout", "-q", "main"]);
    repo.write("g.txt", "g1\nMOD\n");
    git_ok(&repo.path, &["commit", "-qam", "modify g"]);
    try_merge(&repo.path, "feat2");

    assert_eq!(git.conflict_list(&repo.path).await, [ConflictEntry { path: "g.txt".into(), xy: "UD".into() }]);
    assert_eq!(git.stage_content(&repo.path, "g.txt", 3).await, None, "their side has no such file");
    git.take_side(&repo.path, "g.txt", ConflictSide::Theirs, ConflictKind::TheirsDeleted).await.expect("taken");
    assert!(!repo.join("g.txt").exists());
    assert_eq!(git.conflict_count(&repo.path).await, 0);
}
