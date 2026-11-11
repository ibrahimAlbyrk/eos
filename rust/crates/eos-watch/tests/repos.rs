//! The git watcher on real repositories made in temporary folders.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eos_contracts::{GitChangeEvent, GitChangeKind};
use eos_core::SystemClock;
use eos_core::git::{GitDirs, GitWatcher};
use eos_watch::{RepoWatcher, ResolveGitDirs};
use support::{Collected, Dir, PATIENCE, open_fds, text, thread_count};

type Events = Arc<Collected<GitChangeEvent>>;

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn init_repo() -> Dir {
    let dir = Dir::new();
    git(&dir.path, &["init", "-q", "-b", "main"]);
    git(&dir.path, &["config", "user.email", "t@t.t"]);
    git(&dir.path, &["config", "user.name", "t"]);
    git(&dir.path, &["config", "commit.gpgsign", "false"]);
    dir.write("a.txt", "1\n");
    git(&dir.path, &["add", "."]);
    git(&dir.path, &["commit", "-qm", "init"]);
    dir
}

/// The git folders of `cwd`, asked of git itself.
fn git_dirs(cwd: &Path) -> Option<GitDirs> {
    let ask = |what: &str| {
        let out = Command::new("git").arg("-C").arg(cwd).args(["rev-parse", what]).output().ok()?;
        out.status.success().then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
    };
    let common = ask("--git-common-dir")?;
    Some(GitDirs {
        toplevel: ask("--show-toplevel")?,
        git_dir: ask("--absolute-git-dir")?,
        common_dir: if common.is_absolute() { common } else { cwd.join(common) },
    })
}

fn watcher(native_recursive: bool) -> (RepoWatcher, Events) {
    let events: Events = Collected::new();
    let sink = events.clone();
    let resolve: ResolveGitDirs = Arc::new(|dir| Box::pin(async move { git_dirs(&dir) }));
    let watcher =
        RepoWatcher::new(resolve, Arc::new(SystemClock), Arc::new(move |event| sink.push(event)), native_recursive);
    (watcher, events)
}

/// Waits until the watches of a working tree are registered.
async fn ready(watcher: &RepoWatcher, targets: usize) {
    let deadline = Instant::now() + PATIENCE;
    while watcher.targets() < targets {
        assert!(Instant::now() < deadline, "the watches never started");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn saw_since(events: &Events, mark: usize, kind: GitChangeKind) -> bool {
    events.wait_for(|all| all.iter().skip(mark).any(|event| event.kinds.contains(&kind)))
}

#[tokio::test(flavor = "multi_thread")]
async fn git_operations_arrive_as_kinds_under_the_watched_folder() {
    let repo = init_repo();
    let (watcher, events) = watcher(true);
    let _lease = watcher.watch(&repo.path);
    ready(&watcher, 3).await;

    let mut mark = events.len();
    repo.write("a.txt", "2\n");
    assert!(saw_since(&events, mark, GitChangeKind::Worktree), "an edit changes the working tree");

    mark = events.len();
    repo.write("b.txt", "x\n");
    git(&repo.path, &["add", "."]);
    git(&repo.path, &["commit", "-qm", "b"]);
    assert!(saw_since(&events, mark, GitChangeKind::Refs), "a commit moves a ref");
    assert!(saw_since(&events, mark, GitChangeKind::Index), "staging rewrites the index");

    mark = events.len();
    git(&repo.path, &["checkout", "-qb", "feature"]);
    assert!(saw_since(&events, mark, GitChangeKind::Head), "a checkout moves HEAD");

    mark = events.len();
    repo.write("a.txt", "3\n");
    git(&repo.path, &["stash", "-q"]);
    assert!(saw_since(&events, mark, GitChangeKind::Stash));

    // Events carry exactly the folder that was watched: the dashboard keys its git state on it.
    let watched = text(&repo.path);
    for event in events.all() {
        assert_eq!(event.dir, watched);
        assert!(!event.kinds.is_empty());
        let mut once = event.kinds.clone();
        once.dedup();
        assert_eq!(once.len(), event.kinds.len(), "a kind is named once per event");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_under_eos_is_watched_and_nested_noise_is_not() {
    let repo = init_repo();
    git(&repo.path, &["worktree", "add", "-q", ".eos/worktrees/feat", "-b", "feat"]);
    let worktree = std::fs::canonicalize(repo.join(".eos/worktrees/feat")).expect("real path");
    let (watcher, events) = watcher(true);
    let _lease = watcher.watch(&worktree);
    // Its own git folder, the shared refs, the shared top level, the working tree.
    ready(&watcher, 4).await;

    worktree_write(&worktree, "node_modules/dep.txt", "x\n");
    worktree_write(&worktree, ".eos/child.txt", "y\n");
    worktree_write(&worktree, "a.txt", "2\n");
    assert!(saw_since(&events, 0, GitChangeKind::Worktree), "its own path contains .eos and is still watched");
    let all = events.all();
    assert!(all.iter().all(|event| event.dir == text(&worktree)));
    // One edit, one kind: the ignored folders added nothing.
    let kinds: Vec<_> = all.iter().flat_map(|event| event.kinds.clone()).collect();
    assert!(kinds.iter().all(|kind| *kind == GitChangeKind::Worktree), "{kinds:?}");

    // A commit in the worktree reaches the source checkout through the shared refs.
    let source = watcher.watch(&repo.path);
    ready(&watcher, 6).await;
    let mark = events.len();
    git(&worktree, &["commit", "-qam", "in the worktree"]);
    let for_source = text(&repo.path);
    assert!(events.wait_for(|all| {
        all.iter().skip(mark).any(|e| e.dir == for_source && e.kinds.contains(&GitChangeKind::Refs))
    }));
    drop(source);
    assert_eq!(watcher.targets(), 4, "the source's own watches are released, the shared ones stay");
}

fn worktree_write(root: &Path, name: &str, content: &str) {
    let file = root.join(name);
    std::fs::create_dir_all(file.parent().expect("a parent")).expect("the folders");
    std::fs::write(file, content).expect("the file");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_outside_git_is_not_watched() {
    let (plain, repo) = (Dir::new(), init_repo());
    let (watcher, events) = watcher(true);
    let _plain = watcher.watch(&plain.path);
    let _repo = watcher.watch(&repo.path);
    ready(&watcher, 3).await;
    plain.write("file.txt", "data\n");
    repo.write("marker.txt", "m\n");
    assert!(saw_since(&events, 0, GitChangeKind::Worktree));
    assert!(events.all().iter().all(|event| event.dir == text(&repo.path)));
    assert_eq!(watcher.targets(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn leases_are_counted_and_a_release_before_the_watch_starts_is_safe() {
    let repo = init_repo();
    let (watcher, events) = watcher(true);
    // Released at once: the lookup that is still running must not start a watch.
    drop(watcher.watch(&repo.path));
    let (a, b) = (watcher.watch(&repo.path), watcher.watch(&repo.path));
    ready(&watcher, 3).await;
    drop(a);
    assert_eq!(watcher.targets(), 3, "one lease is still held");
    repo.write("a.txt", "2\n");
    assert!(saw_since(&events, 0, GitChangeKind::Worktree));
    drop(b);
    assert_eq!(watcher.targets(), 0);

    watcher.close_all();
    drop(watcher.watch(&repo.path));
    assert_eq!(watcher.targets(), 0, "a closed watcher starts nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tree_over_the_folder_budget_keeps_only_its_git_watches() {
    let repo = init_repo();
    for i in 0..2001 {
        std::fs::create_dir(repo.join(&format!("d{i}"))).expect("mkdir");
    }
    // A system where a recursive watch costs a watch per folder.
    let (watcher, events) = watcher(false);
    let _lease = watcher.watch(&repo.path);
    ready(&watcher, 2).await;
    git(&repo.path, &["commit", "-q", "--allow-empty", "-m", "empty"]);
    assert!(saw_since(&events, 0, GitChangeKind::Refs), "refs are still watched");
    assert_eq!(watcher.targets(), 2, "the working tree is not");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repository_costs_no_descriptor_per_file_or_ref() {
    let repo = init_repo();
    for i in 0..500 {
        repo.write(&format!("f{i}.txt"), "x\n");
    }
    let head = git(&repo.path, &["rev-parse", "HEAD"]);
    for i in 0..200 {
        repo.write(&format!(".git/refs/tags/t{i}"), &format!("{head}\n"));
    }
    let (watcher, events) = watcher(true);
    let before = open_fds();
    let _lease = watcher.watch(&repo.path);
    ready(&watcher, 3).await;
    repo.write("f1.txt", "y\n");
    assert!(saw_since(&events, 0, GitChangeKind::Worktree));
    let opened = open_fds().saturating_sub(before);
    assert!(opened < 20, "the watch opened {opened} descriptors for 500 files and 200 refs");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_watcher_gives_back_its_thread_and_descriptors() {
    let repo = init_repo();
    {
        let (first, _events) = watcher(true);
        let _lease = first.watch(&repo.path);
        ready(&first, 3).await;
    }
    let (fds, threads) = (open_fds(), thread_count());
    for _ in 0..25 {
        let (watcher, _events) = watcher(true);
        let lease = watcher.watch(&repo.path);
        ready(&watcher, 3).await;
        drop(watcher);
        drop(lease);
    }
    let leaked = open_fds().saturating_sub(fds);
    assert!(leaked < 5, "{leaked} descriptors were left open after 25 watchers");
    if let (Some(before), Some(after)) = (threads, thread_count()) {
        assert!(after < before + 5, "threads grew from {before} to {after} after 25 watchers");
    }
}
