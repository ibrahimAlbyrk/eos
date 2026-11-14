//! The git routes answer from kept working-tree snapshots, and each kind of
//! git operation made outside Eos (an agent in its terminal, the user in
//! theirs) reaches them through the repo watcher: once the change's
//! `git:change` event is out, the routes answer what git says. Changes the
//! dashboard has no event kind for (settings, the repository's own rules)
//! reach them too, within the watcher's window.

#[path = "support/rig.rs"]
mod rig;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eos_contracts::GitChangeEvent;
use eos_contracts::stream::topics::GIT_CHANGE;
use eos_core::SystemClock;
use eos_core::git::{GitDiffs, GitInfo};
use eos_git::Git;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_runtime::bus::EventReceiver;
use eos_runtime::http::Method;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

const PATIENCE: Duration = Duration::from_secs(10);

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// git that may refuse (a merge into a conflict).
fn git_any(cwd: &Path, args: &[&str]) {
    Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git runs");
}

fn write(dir: &Path, name: &str, content: &str) {
    let file = dir.join(name);
    std::fs::create_dir_all(file.parent().expect("a parent")).expect("folders");
    std::fs::write(file, content).expect("a file");
}

fn real(dir: &tempfile::TempDir) -> PathBuf {
    std::fs::canonicalize(dir.path()).expect("a real path")
}

struct Bench {
    app: eos_app::App,
    events: EventReceiver,
    repo: PathBuf,
    other: PathBuf,
    /// What git says, asked directly.
    direct: Git,
    _keep: (TempHome, tempfile::TempDir, tempfile::TempDir, tempfile::TempDir),
}

impl Bench {
    async fn new() -> Self {
        let (origin_dir, repo_dir, other_dir) =
            (tempfile::tempdir().expect("a"), tempfile::tempdir().expect("b"), tempfile::tempdir().expect("c"));
        let (origin, repo, other) = (real(&origin_dir), real(&repo_dir), real(&other_dir));
        git(&origin, &["init", "-q", "--bare", "-b", "main"]);
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@t.t"]);
        git(&repo, &["config", "user.name", "t"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        write(&repo, "a.txt", "one\n");
        write(&repo, "b.txt", "bee\n");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        git(&repo, &["remote", "add", "origin", &origin.to_string_lossy()]);
        git(&repo, &["push", "-q", "origin", "main"]);
        git(&repo, &["branch", "side"]);
        git(&other, &["clone", "-q", &origin.to_string_lossy(), "."]);
        git(&other, &["config", "user.email", "t@t.t"]);
        git(&other, &["config", "user.name", "t"]);

        let home = TempHome::new();
        let app = rig::build(home.path(), &ScriptedRuntime::unlogged());
        app.start().await.expect("starts");
        let events = app.runtime().kernel.bus.subscribe(GIT_CHANGE, 256);
        let trees =
            ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
        let direct = Git::new(Runner::new(trees), Arc::new(SystemClock));
        let bench = Self { app, events, repo, other, direct, _keep: (home, origin_dir, repo_dir, other_dir) };
        // The chat on screen: its folder is watched.
        let (status, _) =
            rig::call(&bench.app, Method::Post, "/fs/git/watch", Some(json!({ "dir": bench.repo, "clientId": "tab" })))
                .await;
        assert_eq!(status, 200);
        bench
    }

    fn cwd(&self) -> String {
        self.repo.to_string_lossy().into_owned()
    }

    async fn branches(&self) -> Value {
        let target = format!("/fs/branches?cwd={}", urlencode(&self.cwd()));
        rig::call(&self.app, Method::Get, &target, None).await.1
    }

    async fn changes(&self) -> Value {
        let target = format!("/fs/changes?cwd={}", urlencode(&self.cwd()));
        rig::call(&self.app, Method::Get, &target, None).await.1["files"].clone()
    }

    /// The next `git:change` of the repository.
    async fn next_event(&mut self) -> Option<GitChangeEvent> {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        loop {
            let event = tokio::time::timeout_at(deadline, self.events.recv()).await.ok()?.ok()?;
            let change: GitChangeEvent = event.payload_as().ok()?;
            if Path::new(&change.dir) == self.repo {
                return Some(change);
            }
        }
    }

    /// Lets everything the watcher saw so far go out, so the next event is the next operation's.
    async fn quiet(&mut self) {
        while tokio::time::timeout(Duration::from_millis(400), self.events.recv()).await.is_ok() {}
    }

    /// Waits until `read` answers `want`: the route followed the change.
    async fn follows(&self, what: &str, read: impl AsyncFn(&Self) -> Value, want: Value) {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let got = read(self).await;
            if got == want {
                return;
            }
            assert!(Instant::now() < deadline, "{what}: the route kept {got} while git says {want}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn want_changes(&self) -> Value {
        serde_json::to_value(self.direct.changed_files(&self.repo, None).await).expect("json")
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_git_operation_reaches_the_routes() {
    let mut bench = Bench::new().await;
    // The watch is set up once git has said where the repository is.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let repo = bench.repo.clone();

    // An edit: the route read right after its event already answers anew.
    assert_eq!(bench.changes().await, json!([]));
    bench.quiet().await;
    write(&repo, "a.txt", "two\n");
    let event = bench.next_event().await.expect("an event for the edit");
    assert_eq!(bench.changes().await, bench.want_changes().await, "read right after {event:?}");

    // Staging, committing, checking out and stashing.
    for (what, op) in [
        ("add", &["add", "-A"][..]),
        ("commit", &["commit", "-q", "-m", "two"]),
        ("checkout", &["checkout", "-q", "side"]),
    ] {
        bench.branches().await;
        bench.changes().await;
        git(&repo, op);
        bench.next_event().await.expect("an event");
        let want_changes = bench.want_changes().await;
        bench.follows(what, async |b| b.changes().await, want_changes).await;
        let current = json!(bench.direct.current_branch(&repo).await);
        bench.follows(what, async |b| b.branches().await["current"].clone(), current).await;
    }
    write(&repo, "b.txt", "changed\n");
    bench.next_event().await.expect("an event");
    bench.branches().await;
    git(&repo, &["stash", "-q"]);
    bench.follows("stash", async |b| b.branches().await["stash"].clone(), json!(1)).await;
    bench.follows("stash", async |b| b.changes().await, json!([])).await;
    git(&repo, &["checkout", "-q", "main"]);

    // Somebody else pushed; a fetch brings it in.
    write(&bench.other, "remote.txt", "r\n");
    git(&bench.other, &["add", "-A"]);
    git(&bench.other, &["commit", "-q", "-m", "remote"]);
    git(&bench.other, &["push", "-q", "origin", "main"]);
    git(&repo, &["branch", "-q", "--set-upstream-to=origin/main"]);
    bench.follows("branch -u", async |b| b.branches().await["behind"].clone(), json!(0)).await;
    git(&repo, &["fetch", "-q", "origin"]);
    bench.follows("fetch", async |b| b.branches().await["behind"].clone(), json!(1)).await;
    // `branch --unset-upstream` writes only the configuration: no event, still followed.
    git(&repo, &["branch", "--unset-upstream"]);
    bench.follows("branch --unset-upstream", async |b| b.branches().await["behind"].clone(), Value::Null).await;

    // `remote set-url` writes only the configuration.
    git(&repo, &["remote", "set-url", "origin", "git@github.com:o/r.git"]);
    bench
        .follows("remote set-url", async |b| b.branches().await["remoteUrl"].clone(), json!("https://github.com/o/r"))
        .await;

    // Ignore rules: the repository's .gitignore and its own info/exclude.
    write(&repo, "notes/x.md", "x\n");
    let listed = bench.want_changes().await;
    bench.follows("a new file", async |b| b.changes().await, listed).await;
    write(&repo, ".git/info/exclude", "notes/\n");
    bench.follows("info/exclude", async |b| b.changes().await, json!([])).await;
    write(&repo, ".git/info/exclude", "");
    write(&repo, ".gitignore", "*.md\n");
    let ignored = bench.want_changes().await;
    bench.follows(".gitignore", async |b| b.changes().await, ignored).await;
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "ignore"]);

    // A merge into a conflict, then its abort.
    git(&repo, &["checkout", "-q", "side"]);
    write(&repo, "a.txt", "side\n");
    git(&repo, &["commit", "-q", "-am", "side"]);
    git(&repo, &["checkout", "-q", "main"]);
    write(&repo, "a.txt", "main\n");
    git(&repo, &["commit", "-q", "-am", "main"]);
    bench.branches().await;
    git_any(&repo, &["merge", "-q", "side"]);
    bench.follows("merge", async |b| b.branches().await["conflicts"].clone(), json!(1)).await;
    git(&repo, &["merge", "--abort"]);
    bench.follows("merge --abort", async |b| b.branches().await["conflicts"].clone(), json!(0)).await;

    // A worktree added from a terminal brings its branch.
    let worktree = repo.join(".eos/worktrees/w9");
    git(&repo, &["worktree", "add", "-q", "-b", "w9", &worktree.to_string_lossy()]);
    let branches = json!(bench.direct.list_branches(&repo).await);
    bench.follows("worktree add", async |b| b.branches().await["branches"].clone(), branches).await;

    bench.app.shutdown(Duration::from_secs(5)).await;
}

/// Eos's own writes need no watcher: the git command tells the snapshots
/// itself, and the next read answers anew even for a tree nobody watches.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eos_own_writes_reach_an_unwatched_tree_at_once() {
    let bench = Bench::new().await;
    let (status, _) =
        rig::call(&bench.app, Method::Post, "/fs/git/unwatch", Some(json!({ "dir": bench.repo, "clientId": "tab" })))
            .await;
    assert_eq!(status, 200);
    assert_eq!(bench.branches().await["current"], json!("main"));
    let body = json!({ "cwd": bench.repo, "branch": "side" });
    let (status, answer) = rig::call(&bench.app, Method::Post, "/fs/checkout", Some(body)).await;
    assert_eq!((status, answer["ok"].clone()), (200, json!(true)));
    assert_eq!(bench.branches().await["current"], json!("side"), "read at once, inside the shared second");
    let body = json!({ "cwd": bench.repo, "name": "fresh", "checkout": false });
    rig::call(&bench.app, Method::Post, "/fs/branch/create", Some(body)).await;
    assert_eq!(bench.branches().await["branches"], json!(["fresh", "main", "side"]));
    bench.app.shutdown(Duration::from_secs(5)).await;
}
