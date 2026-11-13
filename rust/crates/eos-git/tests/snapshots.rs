//! The snapshots answer every read exactly as the git adapter does.
//!
//! A throwaway repository with an origin, a second clone that pushes, and a
//! linked worktree where Eos keeps them (`.eos/worktrees/…`) goes through a
//! random run of edits, stages, renames, commits, checkouts, stashes,
//! fetches, upstream and URL changes, ignore rules, conflicts and detached
//! HEADs. After each step every read is asked of both, from the top, from a
//! subfolder and from the worktree, against HEAD and against the fork point.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_core::git::{GitDiffs, GitInfo, RepoState};
use eos_git::{Git, Snapshots};
use support::{Dir, adapter, configure, git, git_ok, head, init_repo, write};

/// xorshift64*: the same run for the same seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

struct World {
    repo: Dir,
    _origin: Dir,
    other: Dir,
    worktree: PathBuf,
    fork: String,
}

impl World {
    fn new() -> Self {
        let origin = Dir::new("eos-snap-origin-");
        git_ok(&origin.path, &["init", "-q", "--bare", "-b", "main"]);
        let repo = init_repo("eos-snap-");
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.write("sub/b.txt", "bee\n");
        repo.write("sub/deep/c.txt", "sea\n");
        repo.write("bin.dat", [0u8, 1, 2, 3, 255, 0]);
        repo.write("run.sh", "echo hi\n");
        repo.write(".gitignore", "*.log\n");
        git_ok(&repo.path, &["add", "-A"]);
        git_ok(&repo.path, &["commit", "-q", "-m", "init"]);
        git_ok(&repo.path, &["remote", "add", "origin", &origin.path.to_string_lossy()]);
        git_ok(&repo.path, &["push", "-q", "-u", "origin", "main"]);
        git_ok(&repo.path, &["branch", "feature/x"]);
        git_ok(&repo.path, &["branch", "fix/y"]);
        let other = Dir::new("eos-snap-other-");
        git_ok(&other.path, &["clone", "-q", &origin.path.to_string_lossy(), "."]);
        configure(&other.path);
        let worktree = repo.join(".eos/worktrees/w1");
        git_ok(&repo.path, &["worktree", "add", "-q", "-b", "eos/w1", &worktree.to_string_lossy(), "main"]);
        let fork = head(&repo.path);
        Self { repo, _origin: origin, other, worktree, fork }
    }

    /// The folders reads are asked from.
    fn folders(&self) -> Vec<PathBuf> {
        vec![self.repo.path.clone(), self.repo.join("sub"), self.worktree.clone()]
    }
}

const NAMES: [&str; 6] =
    ["new.txt", "sub/new file.txt", "sub/deep/n\u{e9}.txt", "notes/x.md", ".eos/stray.txt", "x.log"];

/// One random change. What git refuses (a dirty checkout, a merge with
/// nothing to merge) is part of the run: the state stays as git left it.
fn step(world: &World, rng: &mut Rng) -> String {
    let repo = &world.repo.path;
    let here: &Path = if rng.below(4) == 0 { &world.worktree } else { repo };
    let tracked = ["a.txt", "sub/b.txt", "sub/deep/c.txt", "run.sh"];
    let run = |cwd: &Path, args: &[&str]| {
        git(cwd, args);
    };
    match rng.below(20) {
        0 | 1 => {
            let file = rng.pick(&tracked);
            let path = here.join(file);
            if path.exists() {
                let mut text = fs::read_to_string(&path).unwrap_or_default();
                text.push_str(&format!("line {}\n", rng.next() % 1000));
                fs::write(&path, text).expect("an edit");
            }
            format!("edit {file}")
        }
        2 | 3 => {
            let name = rng.pick(&NAMES);
            write(here, name, format!("{}\n", rng.next()));
            format!("new {name}")
        }
        4 => {
            let file = rng.pick(&tracked);
            let _ = fs::remove_file(here.join(file));
            format!("delete {file}")
        }
        5 => {
            run(here, &["add", "-A"]);
            "add -A".into()
        }
        6 => {
            let (from, to) = (rng.pick(&tracked), format!("moved-{}.txt", rng.below(3)));
            run(here, &["mv", from, &to]);
            format!("mv {from} {to}")
        }
        7 | 8 => {
            run(here, &["add", "-A"]);
            run(here, &["commit", "-q", "-m", "work"]);
            "commit".into()
        }
        9 => {
            let branch = rng.pick(&["main", "feature/x", "fix/y", "eos/w1"]);
            run(repo, &["checkout", "-q", branch]);
            format!("checkout {branch}")
        }
        10 => {
            if rng.below(2) == 0 {
                run(here, &["stash", "push", "-q", "-u"]);
                "stash push".into()
            } else {
                run(here, &["stash", "pop", "-q"]);
                "stash pop".into()
            }
        }
        11 => {
            let other = &world.other.path;
            write(other, "remote.txt", format!("{}\n", rng.next()));
            run(other, &["add", "-A"]);
            run(other, &["commit", "-q", "-m", "remote"]);
            run(other, &["push", "-q", "origin", "main"]);
            run(repo, &["fetch", "-q", "origin"]);
            "fetch after a remote commit".into()
        }
        12 => {
            if rng.below(2) == 0 {
                run(here, &["branch", "-u", "origin/main"]);
                "branch -u origin/main".into()
            } else {
                run(here, &["branch", "--unset-upstream"]);
                "branch --unset-upstream".into()
            }
        }
        13 => {
            let url = rng.pick(&["git@github.com:o/r.git", "https://example.com/o/r.git"]);
            run(repo, &["remote", "set-url", "origin", url]);
            format!("remote set-url {url}")
        }
        14 => {
            let rule = rng.pick(&["notes/\n", "*.md\n", "*.log\n"]);
            if rng.below(2) == 0 {
                write(repo, ".gitignore", rule);
                format!(".gitignore {}", rule.trim())
            } else {
                write(&repo.join(".git/info"), "exclude", rule);
                format!("info/exclude {}", rule.trim())
            }
        }
        15 => {
            // Both sides change the same line: a conflict, or git refuses.
            run(repo, &["checkout", "-q", "fix/y"]);
            write(repo, "a.txt", format!("fix {}\n", rng.next()));
            run(repo, &["commit", "-q", "-am", "fix"]);
            run(repo, &["checkout", "-q", "main"]);
            write(repo, "a.txt", format!("main {}\n", rng.next()));
            run(repo, &["commit", "-q", "-am", "main"]);
            run(repo, &["merge", "-q", "fix/y"]);
            "merge into a conflict".into()
        }
        16 => {
            run(repo, &["merge", "--abort"]);
            "merge --abort".into()
        }
        17 => {
            if rng.below(2) == 0 {
                run(here, &["checkout", "-q", "--detach"]);
                "detach".into()
            } else {
                run(here, &["checkout", "-q", "-"]);
                "checkout -".into()
            }
        }
        18 => {
            if rng.below(2) == 0 {
                run(here, &["update-index", "--chmod=+x", "run.sh"]);
                "chmod +x run.sh".into()
            } else {
                write(here, "bin.dat", [rng.below(250) as u8, 0, 1, 2]);
                "binary edit".into()
            }
        }
        _ => {
            let name = rng.pick(&["zeta", "alpha"]);
            if rng.below(2) == 0 {
                run(repo, &["remote", "add", name, "https://example.com/x.git"]);
                format!("remote add {name}")
            } else {
                run(repo, &["remote", "remove", name]);
                format!("remote remove {name}")
            }
        }
    }
}

/// Every read the snapshots answer, from `cwd`, asked of both.
async fn agree(snap: &Snapshots, git: &Git, cwd: &Path, fork: &str, what: &str) {
    macro_rules! same {
        ($method:ident($($arg:expr),*)) => {
            assert_eq!(
                snap.$method($($arg),*).await,
                git.$method($($arg),*).await,
                "after `{what}`: {} from {}",
                stringify!($method),
                cwd.display()
            );
        };
    }
    same!(is_repo(cwd));
    same!(git_dirs(cwd));
    same!(list_branches(cwd));
    same!(remote_branches(cwd));
    same!(remotes(cwd));
    same!(current_branch(cwd));
    same!(recent_checkouts(cwd));
    same!(remote_url(cwd));
    same!(sync_status(cwd));
    same!(stash_count(cwd));
    same!(conflict_count(cwd));
    same!(conflict_list(cwd));
    same!(rev_parse(cwd, "HEAD"));
    same!(merge_base_ref(cwd, "main"));
    same!(default_base_ref(cwd));
    same!(push_state(cwd));
    same!(pull_state(cwd));
    same!(has_uncommitted_changes(cwd));
    for base in [None, Some(fork)] {
        same!(diff_short_stat(cwd, base));
        same!(changed_files(cwd, base));
        same!(full_diff(cwd, base));
    }
}

async fn run(seed: u64, steps: usize) {
    let world = World::new();
    let git = adapter();
    let snap = Snapshots::new(adapter());
    let mut rng = Rng(seed);
    for cwd in world.folders() {
        agree(&snap, &git, &cwd, &world.fork, "nothing").await;
    }
    for n in 0..steps {
        let what = format!("{n}: {}", step(&world, &mut rng));
        // What Eos's own writes and the watcher do.
        snap.touched(&world.repo.path);
        for cwd in world.folders() {
            if cwd.is_dir() {
                agree(&snap, &git, &cwd, &world.fork, &what).await;
            }
        }
    }
    assert_eq!(snap.kept().refs_by_git, 0, "refs were read in process throughout");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_read_agrees_with_git_through_a_random_run() {
    run(0x5eed_0001, 30).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_read_agrees_with_git_through_another_random_run() {
    run(0x5eed_0002, 30).await;
}

/// The short stat comes out of the same `git diff` as the line counts:
/// binary files, renames, mode changes, conflicts and a first commit not
/// yet made each count as `git diff --shortstat` counts them.
#[tokio::test]
async fn the_short_stat_counts_as_git_diff_shortstat_does() {
    let direct = adapter();
    let check = |repo: PathBuf, what: &'static str| {
        let direct = direct.clone();
        async move {
            let snap = Snapshots::new(adapter());
            for base in [None, Some("HEAD")] {
                assert_eq!(
                    snap.diff_short_stat(&repo, base).await,
                    direct.diff_short_stat(&repo, base).await,
                    "{what}"
                );
            }
            snap.diff_short_stat(&repo, None).await
        }
    };

    let unborn = init_repo("eos-snap-unborn-");
    unborn.write("a.txt", "a\n");
    let stat = check(unborn.path.clone(), "no commit yet").await;
    assert_eq!((stat.files, stat.insertions), (1, 0), "the diff fails: the untracked file only");

    let repo = init_repo("eos-snap-vectors-");
    repo.write("text.txt", "a\nb\nc\n");
    repo.write("bin.dat", [0u8, 1, 2, 3]);
    repo.write("mode.sh", "echo\n");
    repo.write("old name.txt", "the same content\nover lines\n");
    git_ok(&repo.path, &["add", "-A"]);
    git_ok(&repo.path, &["commit", "-q", "-m", "init"]);
    repo.write("text.txt", "a\nB\nc\nd\n");
    repo.write("bin.dat", [9u8, 0, 8]);
    // The file itself becomes executable: a mode change against HEAD.
    git_ok(&repo.path, &["update-index", "--chmod=+x", "mode.sh"]);
    git_ok(&repo.path, &["checkout", "--", "mode.sh"]);
    git_ok(&repo.path, &["mv", "old name.txt", "new name.txt"]);
    let stat = check(repo.path.clone(), "binary, mode change, rename").await;
    // git: ` 4 files changed, 2 insertions(+), 1 deletion(-)`.
    assert_eq!((stat.files, stat.insertions, stat.deletions), (4, 2, 1));

    git_ok(&repo.path, &["commit", "-q", "-am", "more"]);
    git_ok(&repo.path, &["checkout", "-q", "-b", "side"]);
    repo.write("text.txt", "side\n");
    git_ok(&repo.path, &["commit", "-q", "-am", "side"]);
    git_ok(&repo.path, &["checkout", "-q", "main"]);
    repo.write("text.txt", "main\n");
    git_ok(&repo.path, &["commit", "-q", "-am", "main"]);
    let (code, _) = git(&repo.path, &["merge", "side"]);
    assert_ne!(code, 0, "a conflict");
    check(repo.path.clone(), "a file in conflict").await;
}

/// A tree whose kept parts were read is asked again only when told it changed.
#[tokio::test]
async fn kept_answers_last_until_the_tree_is_told_it_changed() {
    let repo = init_repo("eos-snap-kept-");
    repo.write("a.txt", "a\n");
    git_ok(&repo.path, &["add", "-A"]);
    git_ok(&repo.path, &["commit", "-q", "-m", "init"]);
    let dirs = adapter().git_dirs(&repo.path).await.expect("a repository");
    let snap = Snapshots::new(adapter());
    snap.watching(&dirs, true);
    assert!(!snap.has_uncommitted_changes(&repo.path).await);
    repo.write("a.txt", "b\n");
    assert!(!snap.has_uncommitted_changes(&repo.path).await, "kept while nothing said otherwise");
    snap.changed(&dirs.toplevel, eos_core::git::RepoChange::Worktree);
    assert!(snap.has_uncommitted_changes(&repo.path).await);
    snap.unwatching(&dirs, true);
    assert_eq!(snap.kept().trees, 0, "the tree goes with its last watch");
    let _: Arc<dyn RepoState> = Arc::new(snap);
}

/// A watched tree is computed again once a change was gathered, before
/// anybody asks: the read after it is answered from that refresh.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_watched_tree_is_refreshed_once_its_changes_are_gathered() {
    let repo = init_repo("eos-snap-refresh-");
    repo.write("a.txt", "a\n");
    git_ok(&repo.path, &["add", "-A"]);
    git_ok(&repo.path, &["commit", "-q", "-m", "init"]);
    let dirs = adapter().git_dirs(&repo.path).await.expect("a repository");
    let snap = Snapshots::new(adapter());
    snap.watching(&dirs, true);
    assert!(snap.changed_files(&repo.path, None).await.is_empty());

    repo.write("a.txt", "b\n");
    snap.changed(&dirs.toplevel, eos_core::git::RepoChange::Worktree);
    snap.settled(&dirs.toplevel);
    assert_eq!(snap.kept().refreshing, 1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while snap.kept().refreshing > 0 {
        assert!(std::time::Instant::now() < deadline, "the refresh never ended");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // Written after the refresh and told to nobody: the kept answer does not have it.
    repo.write("b.txt", "new\n");
    let paths: Vec<String> = snap.changed_files(&repo.path, None).await.into_iter().map(|f| f.path).collect();
    assert_eq!(paths, ["a.txt"]);

    // A tree nobody watches is not refreshed.
    snap.unwatching(&dirs, true);
    snap.changed_files(&repo.path, None).await;
    snap.changed(&dirs.toplevel, eos_core::git::RepoChange::Worktree);
    snap.settled(&dirs.toplevel);
    assert_eq!(snap.kept().refreshing, 0);
}
