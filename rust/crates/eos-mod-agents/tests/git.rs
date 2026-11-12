//! The routes over a worker's folder against throwaway repositories: what the
//! dashboard and an orchestrator get back, what lands in the checkout and on
//! the timeline. Every repository is made here, under a temporary folder.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use eos_core::store::{EventOrder, EventQuery, Store};
use eos_git::{Git, GitTries};
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_agents::{AgentsModule, Spawning, WorkerGit};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_testkit::{
    FakeClock, FakeConfig, FakeDesktop, FakeModelCatalog, FakePrompts, FakeRecents, FakeScratch, FakeSettings,
    FakeSleeper, FakeWorktrees, ScriptedRuntime, SeqIds, TempStore,
};
use eos_workers::WorkerDefinitions;
use serde_json::{Value, json};

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, file: &str, content: &str) {
    fs::write(dir.join(file), content).expect("writes");
}

fn configure(repo: &Path) {
    git(repo, &["config", "user.email", "t@t.t"]);
    git(repo, &["config", "user.name", "tester"]);
    git(repo, &["config", "commit.gpgsign", "false"]);
}

struct Bench {
    runtime: Runtime,
    temp: TempStore,
    _dir: tempfile::TempDir,
    /// The orchestrator's checkout, `main` with `s.txt`, `a.txt`, `b.txt`.
    repo: PathBuf,
}

impl Bench {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("a folder");
        let repo = fs::canonicalize(dir.path()).expect("its real path").join("repo");
        fs::create_dir(&repo).expect("the repository");
        git(&repo, &["init", "-q", "-b", "main"]);
        configure(&repo);
        write(&repo, "s.txt", "l1\nl2\nl3\n");
        write(&repo, "a.txt", "aaa\n");
        write(&repo, "b.txt", "bbb\n");
        write(&repo, ".gitignore", ".eos/\n");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        let temp = TempStore::new();
        let clock = Arc::new(FakeClock::new());
        let ids = Arc::new(SeqIds::new());
        let config = Arc::new(FakeConfig::default());
        let library = Arc::new(LibraryPromptSource::with_overrides(Vec::new()));
        let spawning = Spawning {
            config: config.clone(),
            settings: Arc::new(FakeSettings::default()),
            prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
            scratch: Arc::new(FakeScratch::default()),
        };
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: ScriptedRuntime::new().port(),
            clock: clock.clone(),
            ids: ids.clone(),
            config,
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
            sleeper: Arc::new(FakeSleeper::default()),
        });
        let trees =
            ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
        let adapter = Arc::new(Git::new(Runner::new(trees), clock.clone()));
        let worker_git = WorkerGit {
            info: adapter.clone(),
            diffs: adapter.clone(),
            push: adapter.clone(),
            remotes: adapter.clone(),
            conflicts: adapter.clone(),
            restore: adapter.clone(),
            tries: Arc::new(GitTries::new(adapter.as_ref().clone(), temp.home.path().join("tries"))),
            merge: adapter,
            desktop: Arc::new(FakeDesktop::default()),
        };
        let files = Arc::new(FsWorkerDefinitionFiles::new(temp.home.path().join("workers")));
        let definitions = Arc::new(WorkerDefinitions::new(files, temp.port(), clock));
        let module = Arc::new(AgentsModule::new(sessions, temp.port(), ids, definitions, spawning, worker_git));
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        let bench = Self { runtime, temp, _dir: dir, repo };
        bench.row("o-1", "IDLE", None, None, true);
        bench
    }

    /// A worker row: `branch` makes it a worktree worker of the checkout.
    fn row(&self, id: &str, state: &str, parent: Option<&str>, branch: Option<&str>, orchestrator: bool) {
        let repo = self.repo.to_string_lossy();
        let text = |v: Option<String>| v.map_or_else(|| "NULL".to_owned(), |v| format!("'{v}'"));
        let (cwd, from, tree) = match branch {
            Some(b) => (None, Some(repo.to_string()), Some(format!("{repo}/.eos/worktrees/{b}"))),
            None => (Some(repo.to_string()), None, None),
        };
        self.temp.exec(&format!(
            "INSERT INTO workers (id, state, cwd, worktree_from, branch, worktree_dir, prompt, name, started_at, parent_id, \
             is_orchestrator, workspace_ready) VALUES ('{id}', '{state}', {}, {}, {}, {}, 'go', 'name of {id}', 1, {}, {}, 1)",
            text(cwd),
            text(from),
            text(branch.map(str::to_owned)),
            text(tree),
            text(parent.map(str::to_owned)),
            i32::from(orchestrator),
        ));
    }

    /// A worker of `o-1` in its own worktree, with uncommitted edits.
    fn worker(&self, id: &str, branch: &str, edits: &[(&str, &str)]) -> PathBuf {
        let tree = self.repo.join(".eos/worktrees").join(branch);
        git(&self.repo, &["worktree", "add", "-q", &tree.to_string_lossy(), "-b", branch]);
        for (file, content) in edits {
            write(&tree, file, content);
        }
        self.row(id, "IDLE", Some("o-1"), Some(branch), false);
        tree
    }

    async fn call(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, target, Caller::DASHBOARD);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let res = self.runtime.router.handle(request).await;
        let status = res.status;
        let bytes = res.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn get(&self, target: &str) -> (u16, Value) {
        self.call(Method::Get, target, None).await
    }

    async fn post(&self, target: &str, body: Value) -> (u16, Value) {
        self.call(Method::Post, target, Some(body)).await
    }

    fn read(&self, file: &str) -> String {
        fs::read_to_string(self.repo.join(file)).expect("the file")
    }

    /// The payloads of the worker's timeline rows of `kind`.
    async fn notes(&self, worker: &str, kind: &str) -> Vec<Value> {
        let store: Arc<dyn Store> = self.temp.port();
        let query = EventQuery {
            worker_id: worker.into(),
            since: 0,
            limit: 100,
            order: EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        let rows = store.read(move |tx| tx.events().list(&query)).await.expect("reads");
        rows.into_iter()
            .filter(|r| r.kind == kind)
            .map(|r| serde_json::from_str(r.payload.as_deref().unwrap_or("null")).expect("json"))
            .collect()
    }
}

fn outcomes(answer: &Value) -> Vec<(String, String)> {
    let workers = answer["workers"].as_array().expect("workers");
    workers
        .iter()
        .map(|w| (w["workerId"].as_str().unwrap_or("").into(), w["outcome"].as_str().unwrap_or("").into()))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disjoint_workers_merge_into_the_orchestrators_checkout() {
    let bench = Bench::new();
    bench.worker("w-1", "eos-w1", &[("a.txt", "aaa\nW1\n")]);
    bench.worker("w-2", "eos-w2", &[("b.txt", "bbb\nW2\n")]);

    let (status, answer) = bench.post("/orchestrators/o-1/integrate", json!({})).await;

    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["checkout"], bench.repo.to_string_lossy().as_ref());
    assert_eq!(answer["branch"], "main");
    assert_eq!(answer["mergedFiles"], json!(["a.txt", "b.txt"]));
    assert_eq!(answer["message"], "Merged 2 workers (2 files) into main.");
    assert_eq!(answer["workers"][0]["name"], "name of w-1");
    assert_eq!((bench.read("a.txt"), bench.read("b.txt")), ("aaa\nW1\n".into(), "bbb\nW2\n".into()));
    let note = &bench.notes("o-1", "workers_integrated").await[0];
    assert_eq!(
        note,
        &json!({"merged": 2, "conflicted": 0, "pending": 0, "skipped": 0, "mergedFiles": ["a.txt", "b.txt"], "conflictedFiles": []})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conflict_is_left_for_the_conflict_view_and_resolved_there() {
    let bench = Bench::new();
    bench.worker("w-1", "eos-w1", &[("s.txt", "W1\nl2\nl3\n")]);
    bench.worker("w-2", "eos-w2", &[("s.txt", "W2\nl2\nl3\n")]);
    bench.worker("w-3", "eos-w3", &[("s.txt", "W3\nl2\nl3\n")]);

    let (_, answer) = bench.post("/orchestrators/o-1/integrate", json!({})).await;
    assert_eq!(
        outcomes(&answer),
        [("w-1".into(), "merged".into()), ("w-2".into(), "conflicted".into()), ("w-3".into(), "pending".into())]
    );
    assert_eq!(answer["conflictedFiles"], json!(["s.txt"]));
    assert_eq!(
        answer["message"],
        "Merged 1 worker (1 files) into main. Conflict in 1 file(s) — resolve in the dashboard conflict view, then re-run. 1 worker(s) pending behind it."
    );

    // The orchestrator's conflict view: the file, its hunks, the resolution.
    let (_, list) = bench.get("/workers/o-1/conflicts").await;
    assert_eq!(list, json!({"files": [{"path": "s.txt", "xy": "UU", "kind": "content"}]}));
    let (status, doc) = bench.get("/workers/o-1/conflicts/file?path=s.txt").await;
    assert_eq!((status, &doc["style"], &doc["conflictCount"]), (200, &json!("merge"), &json!(1)));
    let fingerprint = doc["fingerprint"].clone();
    let stale = json!({"path": "s.txt", "fingerprint": "0:0", "resolutions": [{"id": 0, "choice": "theirs"}]});
    let (status, refused) = bench.post("/workers/o-1/conflicts/resolve", stale).await;
    assert_eq!((status, &refused["reason"]), (409, &json!("stale")));
    let none = json!({"path": "s.txt", "fingerprint": fingerprint, "resolutions": []});
    let (status, incomplete) = bench.post("/workers/o-1/conflicts/resolve", none).await;
    assert_eq!(
        (status, incomplete),
        (409, json!({"ok": false, "staged": false, "unresolved": [0], "remaining": 1, "reason": "incomplete"}))
    );
    let resolution =
        json!({"path": "s.txt", "fingerprint": fingerprint, "resolutions": [{"id": 0, "choice": "theirs"}]});
    let resolved = bench.post("/workers/o-1/conflicts/resolve", resolution).await;
    assert_eq!(resolved, (200, json!({"ok": true, "staged": true, "unresolved": [], "remaining": 0})));
    assert_eq!(bench.read("s.txt"), "W2\nl2\nl3\n");
    assert_eq!(bench.notes("o-1", "conflict_resolved").await, [json!({"path": "s.txt", "remaining": 0})]);
    assert_eq!(bench.get("/workers/o-1/conflicts/file?path=s.txt").await, (404, json!({"error": "not conflicted"})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_cannot_be_merged_is_said_so() {
    let bench = Bench::new();
    // Work the checkout holds already.
    bench.worker("w-same", "eos-same", &[("a.txt", "aaa\nSAME\n")]);
    write(&bench.repo, "a.txt", "aaa\nSAME\n");
    git(&bench.repo, &["commit", "-qam", "the same change by hand"]);
    // A worktree and branch that are gone; one with no branch; one busy; one not on disk; one archived.
    bench.row("w-gone", "IDLE", Some("o-1"), Some("eos-gone"), false);
    bench.row("w-plain", "IDLE", Some("o-1"), None, false);
    bench.worker("w-busy", "eos-busy", &[("b.txt", "busy\n")]);
    bench.temp.exec("UPDATE workers SET state = 'WORKING' WHERE id = 'w-busy'");
    bench.row("w-new", "IDLE", Some("o-1"), Some("eos-new"), false);
    bench.temp.exec("UPDATE workers SET workspace_ready = 0 WHERE id = 'w-new'");
    bench.worker("w-old", "eos-old", &[("b.txt", "old\n")]);
    bench.temp.exec("UPDATE workers SET archived_at = 5 WHERE id = 'w-old'");

    let (status, answer) = bench.post("/orchestrators/o-1/integrate", json!({})).await;

    assert_eq!(status, 200);
    let reasons: Vec<(&str, &str, Option<&str>)> = answer["workers"]
        .as_array()
        .expect("workers")
        .iter()
        .map(|w| (w["workerId"].as_str().unwrap_or(""), w["outcome"].as_str().unwrap_or(""), w["reason"].as_str()))
        .collect();
    assert_eq!(
        reasons,
        [
            ("w-gone", "skipped", Some("no changes to integrate")),
            ("w-same", "merged", None),
            ("w-plain", "skipped", Some("no worktree branch")),
            ("w-busy", "skipped", Some("busy")),
            ("w-new", "skipped", Some("worktree not ready")),
        ]
    );
    assert_eq!(answer["message"], "Merged 1 worker (0 files) into main. 4 skipped.");
    assert_eq!(git(&bench.repo, &["status", "--porcelain"]), "");

    // Only the ones asked for.
    let (_, only) = bench.post("/orchestrators/o-1/integrate", json!({"ids": ["w-plain"]})).await;
    assert_eq!(outcomes(&only), [("w-plain".into(), "skipped".into())]);
    assert_eq!(only["message"], "Nothing to integrate. 1 skipped.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_users_own_edits_stop_a_merge_and_unknowns_are_refused() {
    let bench = Bench::new();
    bench.worker("w-1", "eos-w1", &[("a.txt", "aaa\nW1\n")]);
    write(&bench.repo, "a.txt", "my own edit\n");

    let (_, answer) = bench.post("/orchestrators/o-1/integrate", json!({})).await;
    assert_eq!(answer["ok"], false);
    assert_eq!(
        answer["message"],
        "Integration failed: checkout has local changes to: a.txt — commit or stash before integrating"
    );
    assert_eq!(bench.read("a.txt"), "my own edit\n");

    assert_eq!(
        bench.post("/orchestrators/o-nope/integrate", json!({})).await,
        (404, json!({"error": "orchestrator not found"}))
    );
    let (status, invalid) = bench.post("/orchestrators/o-1/integrate", json!({"ids": "all"})).await;
    assert_eq!((status, invalid), (400, json!({"error": "invalid request: ids: Expected array, received string"})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_try_is_previewed_applied_kept_and_discarded() {
    let bench = Bench::new();
    bench.worker("w-1", "eos-w1", &[("a.txt", "aaa\nW1\n")]);

    let (_, preview) = bench.get("/workers/w-1/try/preview").await;
    assert_eq!(
        (&preview["supported"], &preview["files"], &preview["conflicts"]),
        (&json!(true), &json!(["a.txt"]), &json!([]))
    );
    let applied = bench.post("/workers/w-1/try", json!({})).await;
    assert_eq!(applied, (200, json!({"ok": true, "files": ["a.txt"], "lockfileChanged": false})));
    assert_eq!(bench.read("a.txt"), "aaa\nW1\n");
    assert_eq!(
        bench.notes("w-1", "try_applied").await,
        [json!({"branch": "eos-w1", "files": ["a.txt"], "lockfileChanged": false})]
    );
    let again = bench.post("/workers/w-1/try", json!({})).await;
    assert_eq!(again, (409, json!({"ok": false, "reason": "nothing-to-apply"})));

    let (_, state) = bench.get("/workers/w-1/try/state").await;
    assert_eq!(state["activeTries"][0]["workerId"], "w-1");
    assert_eq!((&state["kept"], &state["syncable"]), (&json!(false), &json!(false)));

    let discarded = bench.post("/workers/w-1/try/discard", json!({"workerId": "w-1"})).await;
    assert_eq!(discarded, (200, json!({"ok": true})));
    assert_eq!(bench.read("a.txt"), "aaa\n");
    assert_eq!(bench.notes("w-1", "try_discarded").await, [json!({"branch": "eos-w1", "files": ["a.txt"]})]);
    let none = bench.post("/workers/w-1/try/discard", json!({"workerId": "w-1"})).await;
    assert_eq!(none, (409, json!({"ok": false, "reason": "no-active-try"})));

    assert_eq!(bench.post("/workers/w-1/try", json!({})).await.0, 200);
    assert_eq!(bench.post("/workers/w-1/try/keep", json!({"workerId": "w-1"})).await, (200, json!({"ok": true})));
    let (_, state) = bench.get("/workers/w-1/try/state").await;
    assert_eq!((&state["activeTries"], &state["kept"]), (&json!([]), &json!(true)));
    assert_eq!(bench.notes("w-1", "try_kept").await.len(), 1);

    // The checkout's own Tries are reached through any worker of it; a worker without a branch has none.
    bench.row("w-plain", "IDLE", None, None, false);
    let refused = bench.post("/workers/w-plain/try", json!({})).await;
    assert_eq!(refused, (409, json!({"error": "worker has no worktree branch"})));
    bench.temp.exec("UPDATE workers SET workspace_ready = 0 WHERE id = 'w-1'");
    let early = bench.get("/workers/w-1/try/preview").await;
    assert_eq!(early, (409, json!({"error": "worktree not registered yet — retry shortly"})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_workers_changes_are_read_and_one_file_is_discarded() {
    let bench = Bench::new();
    let tree = bench.worker("w-1", "eos-w1", &[("a.txt", "aaa\nW1\n"), ("new.txt", "fresh\n")]);
    let fork = git(&bench.repo, &["rev-parse", "HEAD"]);
    bench.temp.exec(&format!("UPDATE workers SET fork_base_sha = '{}' WHERE id = 'w-1'", fork.trim()));
    // A commit the worker made after forking still counts.
    write(&tree, "b.txt", "bbb\ncommitted\n");
    git(&tree, &["commit", "-qm", "worker commit", "--", "b.txt"]);

    let (_, diff) = bench.get("/workers/w-1/diff").await;
    assert_eq!(diff, json!({"insertions": 2, "deletions": 0, "files": 3}), "the untracked file counts as one");
    let (_, changes) = bench.get("/workers/w-1/changes").await;
    let paths: Vec<&str> =
        changes["files"].as_array().expect("files").iter().filter_map(|f| f["path"].as_str()).collect();
    assert_eq!(paths, ["a.txt", "b.txt", "new.txt"]);
    let (_, one) = bench.get("/workers/w-1/changes/file?path=a.txt").await;
    assert!(one["patch"].as_str().expect("a patch").contains("+W1"));
    assert_eq!(
        bench.get("/workers/w-1/changes/file?path=../x").await,
        (400, json!({"error": "path must be repo-relative"}))
    );

    let discarded = bench.post("/workers/w-1/changes/discard", json!({"path": "new.txt"})).await;
    assert_eq!(discarded, (200, json!({"ok": true})));
    assert!(!tree.join("new.txt").exists());
    assert_eq!(bench.post("/workers/w-1/changes/discard", json!({"path": "a.txt"})).await.0, 200);
    assert_eq!(fs::read_to_string(tree.join("a.txt")).expect("read"), "aaa\n");

    let (_, state) = bench.get("/workers/w-1/push-state").await;
    assert_eq!(
        state,
        json!({"branch": "eos-w1", "remote": null, "hasUpstream": false, "ahead": 0, "behind": 0, "kind": "blocked",
               "pushable": false, "hasUncommitted": false, "pullable": false, "pullKind": "blocked"})
    );
    // A worker that is gone reads as nothing to show.
    assert_eq!(bench.get("/workers/w-nope/diff").await, (200, json!({"insertions": 0, "deletions": 0, "files": 0})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_branch_is_pushed_and_pulled_without_an_agent() {
    let bench = Bench::new();
    let remote = bench.repo.with_file_name("remote.git");
    git(&bench.repo, &["init", "-q", "--bare", &remote.to_string_lossy()]);
    git(&bench.repo, &["remote", "add", "origin", &remote.to_string_lossy()]);

    let pushed = bench.post("/workers/o-1/push", json!({})).await;
    assert_eq!(pushed.0, 200);
    assert_eq!((&pushed.1["outcome"], &pushed.1["ok"]), (&json!("pushed-new"), &json!(true)), "{}", pushed.1);
    assert_eq!(bench.notes("o-1", "git_push").await[0]["outcome"], "pushed-new");

    // Someone else pushes; the checkout is fast-forwarded to it.
    let other = bench.repo.with_file_name("other");
    git(&bench.repo, &["clone", "-q", &remote.to_string_lossy(), &other.to_string_lossy()]);
    configure(&other);
    write(&other, "c.txt", "from elsewhere\n");
    git(&other, &["add", "c.txt"]);
    git(&other, &["commit", "-qm", "elsewhere"]);
    git(&other, &["push", "-q", "origin", "main"]);
    git(&bench.repo, &["fetch", "-q", "origin"]);
    let (_, state) = bench.get("/workers/o-1/push-state").await;
    assert_eq!(
        (&state["pullable"], &state["pullKind"], &state["behind"]),
        (&json!(true), &json!("fast-forward"), &json!(1))
    );

    let pulled = bench.post("/workers/o-1/pull", json!({})).await;
    assert_eq!((&pulled.1["outcome"], &pulled.1["message"]), (&json!("pulled"), &json!("Pulled (fast-forward).")));
    assert_eq!(bench.read("c.txt"), "from elsewhere\n");
    assert_eq!(bench.notes("o-1", "git_pull").await.len(), 1);
    assert_eq!(bench.post("/workers/w-nope/push", json!({})).await, (404, json!({"error": "worker not found"})));
}
