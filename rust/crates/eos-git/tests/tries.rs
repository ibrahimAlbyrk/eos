//! Try on throwaway repositories: apply, keep, discard, sync, stacking
//! (`infra/src/__tests__/ChildProcessBranchIntegration.test.ts`).

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use eos_core::git::{BranchIntegration, TryApplied, TryApplyRefusal, TryDiscardRefusal, TryDiscarded, TrySync};
use eos_domain::WorkerBranch;
use eos_git::GitTries;
use support::{Dir, adapter, commit_file, configure, git_ok, write};

const BRANCH: &str = "eos-test-w1";

struct Bench {
    base: Dir,
    repo: PathBuf,
    worktree: PathBuf,
}

impl Bench {
    fn new() -> Self {
        let base = Dir::new("branch-integration-");
        let repo = base.join("repo");
        fs::create_dir_all(&repo).expect("the repository folder");
        git_ok(&repo, &["init", "-q", "-b", "main"]);
        configure(&repo);
        write(&repo, "a.txt", "line1\nline2\nline3\n");
        write(&repo, "b.txt", "b\n");
        // Repositories that hold managed worktrees ignore `.eos/`.
        commit_file(&repo, ".gitignore", ".eos/\n", "init");
        let bench = Self { worktree: repo.join(".eos/worktrees").join(BRANCH), repo, base };
        bench.add_worktree(BRANCH);
        bench
    }

    fn tries(&self) -> GitTries {
        GitTries::new(adapter(), self.base.join("tries"))
    }

    fn add_worktree(&self, name: &str) -> PathBuf {
        let dir = self.repo.join(".eos/worktrees").join(name);
        git_ok(&self.repo, &["worktree", "add", "-q", &dir.to_string_lossy(), "-b", name]);
        dir
    }

    fn worker(&self) -> WorkerBranch {
        WorkerBranch {
            repo_root: self.repo.clone(),
            worktree_dir: Some(self.worktree.clone()),
            branch: BRANCH.into(),
            worker_id: "w-1".into(),
        }
    }

    fn second(&self) -> WorkerBranch {
        let worktree = self.add_worktree("eos-test-w2");
        WorkerBranch {
            repo_root: self.repo.clone(),
            worktree_dir: Some(worktree),
            branch: "eos-test-w2".into(),
            worker_id: "w-2".into(),
        }
    }

    fn read(&self, file: &str) -> String {
        fs::read_to_string(self.repo.join(file)).expect("the file")
    }

    fn status(&self) -> String {
        git_ok(&self.repo, &["status", "--porcelain"]).trim().to_owned()
    }

    fn snapshot_refs(&self) -> String {
        git_ok(&self.repo, &["for-each-ref", "refs/eos/snapshots"]).trim().to_owned()
    }
}

fn edit(dir: &Path, file: &str, content: &str) {
    write(dir, file, content);
}

fn applied_files(result: &TryApplied) -> Vec<String> {
    match result {
        TryApplied::Applied { files, .. } => files.clone(),
        TryApplied::Refused { .. } => panic!("refused: {result:?}"),
    }
}

fn refusal(result: &TryApplied) -> (TryApplyRefusal, Option<Vec<String>>, Option<String>) {
    match result {
        TryApplied::Refused { reason, files, detail } => (*reason, files.clone(), detail.clone()),
        TryApplied::Applied { .. } => panic!("applied"),
    }
}

fn discard_refusal(result: &TryDiscarded) -> (TryDiscardRefusal, Option<Vec<String>>, Option<String>) {
    match result {
        TryDiscarded::Refused { reason, files, detail } => (*reason, files.clone(), detail.clone()),
        TryDiscarded::Discarded => panic!("discarded"),
    }
}

#[tokio::test]
async fn apply_lands_the_worktree_as_unstaged_edits_and_keep_settles_it() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    edit(&b.worktree, "new.txt", "fresh\n");
    let tries = b.tries();

    let files = applied_files(&tries.apply(&b.worker()).await);
    assert!(files.contains(&"a.txt".into()) && files.contains(&"new.txt".into()), "{files:?}");
    assert_eq!((b.read("a.txt"), b.read("new.txt")), ("line1 EDITED\nline2\nline3\n".into(), "fresh\n".into()));
    assert_eq!(git_ok(&b.repo, &["diff", "--cached", "--name-only"]).trim(), "", "nothing staged");
    assert!(!b.repo.join(".git/MERGE_HEAD").exists());
    let active = tries.active_tries(&b.repo).await;
    assert_eq!(active.iter().map(|t| t.worker_id.as_str()).collect::<Vec<_>>(), ["w-1"]);

    assert!(tries.keep(&b.repo, "w-1").await);
    assert!(tries.active_tries(&b.repo).await.is_empty());
    assert_eq!(b.read("a.txt"), "line1 EDITED\nline2\nline3\n", "edits stay after keep");
    assert!(!tries.keep(&b.repo, "w-nope").await);
}

#[tokio::test]
async fn discard_restores_the_checkout_created_files_included() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    edit(&b.worktree, "new.txt", "fresh\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);

    assert_eq!(tries.discard(&b.repo, "w-1").await, TryDiscarded::Discarded);
    assert_eq!(b.read("a.txt"), "line1\nline2\nline3\n");
    assert!(!b.repo.join("new.txt").exists());
    assert_eq!(b.status(), "");
    assert!(tries.active_tries(&b.repo).await.is_empty());
    let none = discard_refusal(&tries.discard(&b.repo, "w-1").await);
    assert_eq!(none.0, TryDiscardRefusal::NoActiveTry);
}

#[tokio::test]
async fn discard_refuses_a_file_the_user_edited_during_the_try() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    edit(&b.repo, "a.txt", "line1 EDITED BY USER\nline2\nline3\n");

    let (reason, files, _) = discard_refusal(&tries.discard(&b.repo, "w-1").await);
    assert_eq!((reason, files), (TryDiscardRefusal::UserEdited, Some(vec!["a.txt".into()])));
    assert_eq!(b.read("a.txt"), "line1 EDITED BY USER\nline2\nline3\n", "nothing reverted");
    assert_eq!(tries.active_tries(&b.repo).await.len(), 1, "still open");
}

#[tokio::test]
async fn applying_again_brings_only_what_the_worker_changed_since() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    edit(&b.worktree, "new.txt", "fresh\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);

    edit(&b.worktree, "a.txt", "line1 FIXED\nline2\nline3\n");
    edit(&b.worktree, "new2.txt", "second\n");
    let again = applied_files(&tries.apply(&b.worker()).await);
    assert!(again.contains(&"a.txt".into()) && again.contains(&"new2.txt".into()), "{again:?}");
    assert!(!again.contains(&"new.txt".into()), "only the delta: {again:?}");
    assert_eq!((b.read("a.txt"), b.read("new2.txt")), ("line1 FIXED\nline2\nline3\n".into(), "second\n".into()));
    assert_eq!(tries.active_tries(&b.repo).await.len(), 1, "synced in place, not stacked");

    // A discard reverses the whole layer.
    assert_eq!(tries.discard(&b.repo, "w-1").await, TryDiscarded::Discarded);
    assert_eq!(b.read("a.txt"), "line1\nline2\nline3\n");
    assert!(!b.repo.join("new.txt").exists() && !b.repo.join("new2.txt").exists());
    assert_eq!(b.status(), "");
}

#[tokio::test]
async fn applying_again_with_nothing_new_has_nothing_to_apply() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    assert_eq!(refusal(&tries.apply(&b.worker()).await).0, TryApplyRefusal::NothingToApply);
}

#[tokio::test]
async fn applying_again_never_overwrites_an_edit_made_after_the_first_apply() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    edit(&b.repo, "a.txt", "line1 USER EDIT\nline2\nline3\n");
    edit(&b.worktree, "a.txt", "line1 WORKER FIX\nline2\nline3\n");

    let (reason, files, _) = refusal(&tries.apply(&b.worker()).await);
    assert_eq!((reason, files), (TryApplyRefusal::DirtyFiles, Some(vec!["a.txt".into()])));
    assert_eq!(b.read("a.txt"), "line1 USER EDIT\nline2\nline3\n");
}

#[tokio::test]
async fn a_kept_try_can_still_be_synced_and_goes_back_to_the_deck() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    assert!(tries.keep(&b.repo, "w-1").await);
    assert!(tries.active_tries(&b.repo).await.is_empty());
    assert!(tries.was_kept(&b.repo, "w-1").await);
    assert_eq!(tries.sync_status(&b.worker()).await, TrySync::default());

    edit(&b.worktree, "a.txt", "line1 BUGFIX\nline2\nline3\n");
    assert_eq!(tries.sync_status(&b.worker()).await, TrySync { syncable: true, files: vec!["a.txt".into()] });

    applied_files(&tries.apply(&b.worker()).await);
    assert_eq!(b.read("a.txt"), "line1 BUGFIX\nline2\nline3\n");
    assert_eq!(tries.active_tries(&b.repo).await.len(), 1);
    assert!(!tries.was_kept(&b.repo, "w-1").await);
}

#[tokio::test]
async fn cleanup_settles_a_kept_try() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    assert!(tries.keep(&b.repo, "w-1").await);
    assert!(b.snapshot_refs().contains("w-1"), "a kept Try keeps its ref until the worker goes");

    tries.cleanup_snapshot(&b.repo, "w-1").await;
    assert_eq!(b.read("a.txt"), "line1 EDITED\nline2\nline3\n");
    assert_eq!(b.snapshot_refs(), "");
    assert!(!tries.was_kept(&b.repo, "w-1").await);
}

#[tokio::test]
async fn cleanup_leaves_an_open_try_discardable() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);

    tries.cleanup_snapshot(&b.repo, "w-1").await;
    assert!(b.snapshot_refs().contains("w-1"));
    assert_eq!(tries.discard(&b.repo, "w-1").await, TryDiscarded::Discarded);
    assert_eq!(b.read("a.txt"), "line1\nline2\nline3\n");
    assert_eq!(b.snapshot_refs(), "");

    // Without a Try, a preview pins nothing and a cleanup is a no-op.
    edit(&b.worktree, "a.txt", "line1 AGAIN\nline2\nline3\n");
    assert!(tries.preview(&b.worker()).await.supported);
    assert_eq!(b.snapshot_refs(), "");
    tries.cleanup_snapshot(&b.repo, "w-1").await;
    assert_eq!(b.snapshot_refs(), "");
}

#[tokio::test]
async fn disjoint_tries_of_two_workers_stack_and_go_in_any_order() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 W1\nline2\nline3\n");
    let w2 = b.second();
    edit(w2.worktree_dir.as_deref().expect("a worktree"), "b.txt", "b W2\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    applied_files(&tries.apply(&w2).await);
    assert_eq!((b.read("a.txt"), b.read("b.txt")), ("line1 W1\nline2\nline3\n".into(), "b W2\n".into()));
    let ids: Vec<String> = tries.active_tries(&b.repo).await.into_iter().map(|t| t.worker_id).collect();
    assert_eq!(ids, ["w-1", "w-2"]);

    assert_eq!(tries.discard(&b.repo, "w-1").await, TryDiscarded::Discarded);
    assert_eq!((b.read("a.txt"), b.read("b.txt")), ("line1\nline2\nline3\n".into(), "b W2\n".into()));
    assert_eq!(tries.discard(&b.repo, "w-2").await, TryDiscarded::Discarded);
    assert_eq!(b.status(), "");
}

#[tokio::test]
async fn an_overlapping_try_blocks_discarding_the_one_below_it() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 W1\nline2\nline3\n");
    let w2 = b.second();
    edit(w2.worktree_dir.as_deref().expect("a worktree"), "a.txt", "line1\nline2\nline3 W2\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    applied_files(&tries.apply(&w2).await);
    assert_eq!(b.read("a.txt"), "line1 W1\nline2\nline3 W2\n");

    let blocked = discard_refusal(&tries.discard(&b.repo, "w-1").await);
    assert_eq!(blocked, (TryDiscardRefusal::BlockedByOverlay, Some(vec!["a.txt".into()]), Some("w-2".into())));

    assert_eq!(tries.discard(&b.repo, "w-2").await, TryDiscarded::Discarded);
    assert_eq!(b.read("a.txt"), "line1 W1\nline2\nline3\n");
    assert_eq!(tries.discard(&b.repo, "w-1").await, TryDiscarded::Discarded);
    assert_eq!(b.status(), "");
}

#[tokio::test]
async fn keeping_any_layer_leaves_the_one_above_discardable() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 W1\nline2\nline3\n");
    let w2 = b.second();
    edit(w2.worktree_dir.as_deref().expect("a worktree"), "a.txt", "line1\nline2\nline3 W2\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);
    applied_files(&tries.apply(&w2).await);

    assert!(tries.keep(&b.repo, "w-1").await);
    assert_eq!(b.read("a.txt"), "line1 W1\nline2\nline3 W2\n");
    assert!(tries.was_kept(&b.repo, "w-1").await);
    assert_eq!(tries.discard(&b.repo, "w-2").await, TryDiscarded::Discarded);
    assert_eq!(b.read("a.txt"), "line1 W1\nline2\nline3\n");
}

#[tokio::test]
async fn a_try_conflicting_only_with_another_try_names_it() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 W1\nline2\nline3\n");
    let w2 = b.second();
    edit(w2.worktree_dir.as_deref().expect("a worktree"), "a.txt", "line1 W2\nline2\nline3\n");
    let tries = b.tries();
    applied_files(&tries.apply(&b.worker()).await);

    let (reason, files, detail) = refusal(&tries.apply(&w2).await);
    assert_eq!(
        (reason, files, detail),
        (TryApplyRefusal::ConflictsWithTry, Some(vec!["a.txt".into()]), Some("w-1".into()))
    );
    assert_eq!(b.read("a.txt"), "line1 W1\nline2\nline3\n", "nothing changed");
    assert_eq!(tries.active_tries(&b.repo).await.len(), 1);
}

#[tokio::test]
async fn the_users_own_edit_to_a_touched_file_refuses_the_apply_and_others_do_not() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    edit(&b.repo, "a.txt", "line1 user-dirty\nline2\nline3\n");
    let (reason, files, _) = refusal(&tries.apply(&b.worker()).await);
    assert_eq!((reason, files), (TryApplyRefusal::DirtyFiles, Some(vec!["a.txt".into()])));

    edit(&b.repo, "a.txt", "line1\nline2\nline3\n");
    edit(&b.repo, "b.txt", "user wip\n");
    applied_files(&tries.apply(&b.worker()).await);
    assert_eq!(b.read("b.txt"), "user wip\n");
}

#[tokio::test]
async fn preview_reports_conflicts_without_touching_the_checkout() {
    let b = Bench::new();
    commit_file(&b.repo, "a.txt", "line1 USER\nline2\nline3\n", "user change");
    edit(&b.worktree, "a.txt", "line1 WORKER\nline2\nline3\n");
    let tries = b.tries();

    let preview = tries.preview(&b.worker()).await;
    assert!(preview.supported);
    assert_eq!(preview.conflicts, ["a.txt"]);
    assert_eq!(b.status(), "");
    let (reason, files, _) = refusal(&tries.apply(&b.worker()).await);
    assert_eq!((reason, files), (TryApplyRefusal::Conflicts, Some(vec!["a.txt".into()])));
}

#[tokio::test]
async fn preview_counts_commits_ahead_and_lists_the_files() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    git_ok(&b.worktree, &["commit", "-aqm", "worker commit"]);
    edit(&b.worktree, "new.txt", "fresh\n");

    let preview = b.tries().preview(&b.worker()).await;
    assert!(preview.supported && preview.conflicts.is_empty());
    // The branch's commit and the snapshot of the uncommitted file.
    assert_eq!((preview.ahead, preview.behind), (2, 0));
    assert_eq!(preview.files, ["a.txt", "new.txt"]);
}

#[tokio::test]
async fn nothing_to_bring_and_a_lockfile_are_said_so() {
    let b = Bench::new();
    let tries = b.tries();
    assert_eq!(refusal(&tries.apply(&b.worker()).await).0, TryApplyRefusal::NothingToApply);
    edit(&b.worktree, "package-lock.json", "{}\n");
    assert!(matches!(tries.apply(&b.worker()).await, TryApplied::Applied { lockfile_changed: true, .. }));
}

#[tokio::test]
async fn a_gone_worktree_is_stood_for_by_its_branch() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    git_ok(&b.worktree, &["commit", "-aqm", "worker commit"]);
    git_ok(&b.repo, &["worktree", "remove", "--force", &b.worktree.to_string_lossy()]);

    let gone = WorkerBranch { worktree_dir: None, ..b.worker() };
    applied_files(&b.tries().apply(&gone).await);
    assert_eq!(b.read("a.txt"), "line1 EDITED\nline2\nline3\n");
}

#[tokio::test]
async fn kept_is_set_by_keep_only_and_outlives_other_tries() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    let tries = b.tries();
    assert!(!tries.was_kept(&b.repo, "w-1").await);
    applied_files(&tries.apply(&b.worker()).await);
    assert!(tries.keep(&b.repo, "w-1").await);
    assert!(tries.was_kept(&b.repo, "w-1").await && !tries.was_kept(&b.repo, "w-other").await);

    let w2 = b.second();
    edit(w2.worktree_dir.as_deref().expect("a worktree"), "b.txt", "b CHANGED\n");
    applied_files(&tries.apply(&w2).await);
    assert_eq!(tries.discard(&b.repo, "w-2").await, TryDiscarded::Discarded);
    assert!(!tries.was_kept(&b.repo, "w-2").await);
    assert!(tries.was_kept(&b.repo, "w-1").await);
}

#[tokio::test]
async fn the_single_try_of_older_versions_becomes_a_stack() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    applied_files(&b.tries().apply(&b.worker()).await);

    // The state as older versions wrote it.
    let dir = fs::read_dir(b.base.join("tries")).expect("the folder").next().expect("one").expect("an entry").path();
    let stack: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("tries.json")).expect("read")).expect("json");
    fs::write(dir.join("try.json"), stack[0].to_string()).expect("write");
    fs::remove_file(dir.join("tries.json")).expect("remove");
    fs::rename(dir.join("w-1.patch"), dir.join("try.patch")).expect("rename");

    let tries = b.tries();
    let active = tries.active_tries(&b.repo).await;
    assert_eq!(active.iter().map(|t| t.worker_id.as_str()).collect::<Vec<_>>(), ["w-1"]);
    assert_eq!(tries.discard(&b.repo, "w-1").await, TryDiscarded::Discarded);
    assert_eq!(b.read("a.txt"), "line1\nline2\nline3\n");
}

#[tokio::test]
async fn the_state_file_is_written_where_and_as_today() {
    let b = Bench::new();
    edit(&b.worktree, "a.txt", "line1 EDITED\nline2\nline3\n");
    applied_files(&b.tries().apply(&b.worker()).await);
    let key: String = b
        .repo
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let dir = b.base.join("tries").join(key);
    let stack: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("tries.json")).expect("read")).expect("json");
    let layer = &stack[0];
    let keys: Vec<&str> = layer.as_object().expect("an object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["workerId", "branch", "baseHead", "snapshotSha", "kept", "lockfileChanged", "createdAt", "files"]
    );
    assert_eq!(layer["files"][0]["path"], "a.txt");
    assert!(dir.join("w-1.patch").exists());
}
