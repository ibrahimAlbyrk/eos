//! An agent's worktree: made, hydrated, listed and removed; and the files of
//! a project that search looks at.

mod support;

use std::fs;
use std::path::PathBuf;

use eos_core::git::{CandidateFiles, WorktreeCreate, WorktreeCreated, WorktreeManager, WorktreeRef, WorktreeRemoved};
use support::{Dir, adapter, commit_file, git, git_ok, head, init_repo};

fn repo() -> Dir {
    let repo = init_repo("eos-wm-");
    commit_file(&repo.path, "README.md", "hi\n", "init");
    repo
}

fn add_worktree(repo: &Dir, branch: &str) -> PathBuf {
    let dir = repo.join(&format!(".eos/worktrees/{branch}"));
    fs::create_dir_all(dir.parent().expect("parent")).expect("dirs");
    git_ok(&repo.path, &["worktree", "add", "-q", dir.to_str().expect("utf-8"), "-b", branch]);
    fs::canonicalize(dir).expect("real path")
}

fn reference(repo: &Dir, dir: Option<&PathBuf>, branch: &str) -> WorktreeRef {
    WorktreeRef { repo_root: repo.path.clone(), worktree_dir: dir.cloned(), branch: branch.into() }
}

fn create(repo: &Dir, branch: &str) -> WorktreeCreate {
    WorktreeCreate {
        repo_root: repo.path.clone(),
        branch: branch.into(),
        worktree_dir: None,
        carry_uncommitted: false,
        hydrate_env: false,
    }
}

fn created(result: WorktreeCreated) -> (PathBuf, Option<String>) {
    match result {
        WorktreeCreated::Created { worktree_dir, fork_base_sha } => (worktree_dir, fork_base_sha),
        WorktreeCreated::Refused { reason } => panic!("refused: {reason}"),
    }
}

#[tokio::test]
async fn a_worktree_is_removed_with_its_branch_whatever_is_in_it() {
    let (repo, wm) = (repo(), adapter());
    let dir = add_worktree(&repo, "eos-dirty-1");
    fs::write(dir.join("scratch.txt"), "uncommitted work\n").expect("write");
    assert_eq!(wm.remove(&reference(&repo, Some(&dir), "eos-dirty-1")).await, WorktreeRemoved::Removed);
    assert!(!dir.exists());
    assert!(!git_ok(&repo.path, &["branch", "--list", "eos-dirty-1"]).contains("eos-dirty-1"));
    // Removing what is already gone is still a success.
    assert_eq!(wm.remove(&reference(&repo, Some(&dir), "eos-dirty-1")).await, WorktreeRemoved::Removed);

    // The folder is derived from the branch when none is given.
    let derived = add_worktree(&repo, "eos-derive-3");
    assert_eq!(wm.remove(&reference(&repo, None, "eos-derive-3")).await, WorktreeRemoved::Removed);
    assert!(!derived.exists());
}

#[tokio::test]
async fn commits_only_the_branch_held_stay_reachable_under_a_tag() {
    let (repo, wm) = (repo(), adapter());
    let dir = add_worktree(&repo, "eos-trash-5");
    fs::write(dir.join("work.txt"), "committed work\n").expect("write");
    git_ok(&dir, &["add", "-A"]);
    git_ok(&dir, &["commit", "-q", "-m", "worker commit"]);
    assert_eq!(wm.remove(&reference(&repo, Some(&dir), "eos-trash-5")).await, WorktreeRemoved::Removed);
    let tags = git_ok(&repo.path, &["tag", "--list", "eos/trash/eos-trash-5-*"]);
    let tag = tags.lines().next().expect("a tag");
    assert_eq!(git(&repo.path, &["rev-parse", &format!("{tag}^{{commit}}")]).0, 0);

    let clean = add_worktree(&repo, "eos-clean-6");
    assert_eq!(wm.remove(&reference(&repo, Some(&clean), "eos-clean-6")).await, WorktreeRemoved::Removed);
    assert_eq!(git_ok(&repo.path, &["tag", "--list", "eos/trash/eos-clean-6-*"]).trim(), "");
}

#[tokio::test]
async fn the_repository_itself_is_never_removed() {
    let (repo, wm) = (repo(), adapter());
    let refused = wm.remove(&reference(&repo, Some(&repo.path), "whatever")).await;
    assert_eq!(refused, WorktreeRemoved::Refused { reason: "refusing repo root" });
    assert!(repo.path.exists());
    assert_eq!(wm.remove(&reference(&repo, None, "")).await, WorktreeRemoved::Refused { reason: "no branch" });
}

#[tokio::test]
async fn worktrees_are_listed_with_the_main_one_marked() {
    let (repo, wm) = (repo(), adapter());
    let dir = add_worktree(&repo, "eos-list-4");
    let entries = wm.list_worktrees(&repo.path).await;
    let main = entries.iter().find(|e| e.path == repo.path).expect("the main worktree");
    assert!(main.is_main);
    let child = entries.iter().find(|e| e.path == dir).expect("the added worktree");
    assert_eq!((child.is_main, child.branch.as_deref(), child.locked), (false, Some("eos-list-4"), false));
    assert!(wm.list_worktrees(&Dir::new("eos-plain-").path).await.is_empty());
}

#[tokio::test]
async fn a_worktree_is_created_on_a_new_branch_at_head() {
    let (repo, wm) = (repo(), adapter());
    let (dir, base) = created(wm.create(&create(&repo, "eos-create-1")).await);
    assert_eq!(dir, fs::canonicalize(repo.join(".eos/worktrees/eos-create-1")).expect("real path"));
    assert_eq!(base, Some(head(&repo.path)));

    let custom = repo.join(".eos/worktrees/custom-2");
    let input = WorktreeCreate { worktree_dir: Some(custom.clone()), ..create(&repo, "eos-create-2") };
    assert_eq!(created(wm.create(&input).await).0, fs::canonicalize(custom).expect("real path"));

    let duplicate = wm.create(&create(&repo, "eos-create-1")).await;
    assert!(matches!(duplicate, WorktreeCreated::Refused { reason } if reason.contains("already exists")));
    let plain = Dir::new("eos-norepo-");
    let not_repo = WorktreeCreate { repo_root: plain.path.clone(), ..create(&repo, "x") };
    assert_eq!(wm.create(&not_repo).await, WorktreeCreated::Refused { reason: "not a git repo".into() });
    assert_eq!(wm.create(&create(&repo, "")).await, WorktreeCreated::Refused { reason: "no branch".into() });
}

#[tokio::test]
async fn uncommitted_work_is_carried_into_the_worktree_when_asked() {
    let (repo, wm) = (repo(), adapter());
    repo.write("carry-scratch.txt", "uncommitted\n");
    repo.write("README.md", "hi\nedited\n");
    let input = WorktreeCreate { carry_uncommitted: true, ..create(&repo, "eos-create-carry-3") };
    let (dir, base) = created(wm.create(&input).await);
    assert_eq!(fs::read_to_string(dir.join("carry-scratch.txt")).expect("carried"), "uncommitted\n");
    assert_eq!(fs::read_to_string(dir.join("README.md")).expect("carried"), "hi\nedited\n");
    assert_ne!(base, Some(head(&repo.path)), "the fork base is the snapshot commit");
    // The source is left exactly as it was: nothing staged, nothing committed.
    assert_eq!(git_ok(&repo.path, &["status", "--porcelain"]), " M README.md\n?? .eos/\n?? carry-scratch.txt\n");

    // A clean source forks from HEAD.
    let clean = init_repo("eos-wm-clean-");
    commit_file(&clean.path, "a.txt", "a\n", "init");
    let input = WorktreeCreate { carry_uncommitted: true, ..create(&clean, "eos-clean-carry") };
    assert_eq!(created(wm.create(&input).await).1, Some(head(&clean.path)));
}

#[tokio::test]
async fn ignored_dependencies_come_along_and_env_files_only_when_asked() {
    let (repo, wm) = (repo(), adapter());
    repo.write(".gitignore", "node_modules/\n.env\n.eos/\n");
    repo.write("node_modules/pkg/index.js", "module.exports = 1;\n");
    repo.write(".env", "SECRET=1\n");
    // Not ignored: bringing it along would leave the worktree dirty.
    repo.write("packages/app/.env.local", "B=2\n");

    let (plain, _) = created(wm.create(&create(&repo, "eos-hydrate-5")).await);
    assert_eq!(fs::read_to_string(plain.join("node_modules/pkg/index.js")).expect("hydrated"), "module.exports = 1;\n");
    assert!(!plain.join(".env").exists());

    let input = WorktreeCreate { hydrate_env: true, ..create(&repo, "eos-hydrate-6") };
    let (with_env, _) = created(wm.create(&input).await);
    assert_eq!(fs::read_to_string(with_env.join(".env")).expect("hydrated"), "SECRET=1\n");
    assert!(!with_env.join("packages/app/.env.local").exists());
}

#[tokio::test]
async fn candidate_files_are_tracked_then_untracked_without_ignored_ones() {
    let (repo, git) = (init_repo("eos-cand-git-"), adapter());
    repo.write("src/a.ts", "");
    repo.write("z.ts", "");
    repo.write(".gitignore", "ignored.ts\n");
    git_ok(&repo.path, &["add", "-A"]);
    repo.write("b-untracked.ts", "");
    repo.write("çay ö.ts", "");
    repo.write("ignored.ts", "");
    assert_eq!(*git.list(&repo.path).await, [".gitignore", "src/a.ts", "z.ts", "b-untracked.ts", "çay ö.ts"]);
}

#[tokio::test]
async fn a_folder_without_git_is_walked_skipping_hidden_and_ignored_names() {
    let (plain, git) = (Dir::new("eos-cand-walk-"), adapter());
    plain.write("top.ts", "");
    plain.write("sub/deep.ts", "");
    plain.write("sub/node_modules/dep.js", "");
    plain.write(".hidden/x.ts", "");
    plain.write("a/b/c/d/five.ts", "");
    plain.write("a/b/c/d/e/six.ts", "");
    // A folder's entries in name order, a subfolder's files where the subfolder sorts.
    assert_eq!(*git.list(&plain.path).await, ["a/b/c/d/five.ts", "sub/deep.ts", "top.ts"]);
}
