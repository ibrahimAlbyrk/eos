//! Probe (not a budget): the git routes a chat switch and the Changes tab
//! fire, timed through the router on a throwaway repository, cold (the tree
//! is not watched and nothing is kept) and warm (the tree is watched, as the
//! dashboard watches the chat it shows).
//!
//! `GIT_PERF_ROOT` names a folder holding `repo/` (the main checkout),
//! `wt/` (a linked worktree on its own branch) and `fork_base` (the sha the
//! worktree forked from). Run in release, alone:
//!   GIT_PERF_ROOT=… cargo test --release -p eos-app --test git_perf -- --ignored --nocapture

#[path = "support/rig.rs"]
mod rig;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use eos_runtime::http::{Method, Request};
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::json;

/// What a tree nobody watches keeps at most: a cold round waits it out.
const SHARED_FOR: Duration = Duration::from_millis(1100);

fn rounds() -> usize {
    std::env::var("GIT_PERF_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(15)
}

fn insert_workers(home: &Path, repo: &str, wt: &str, fork: &str) {
    let db = rusqlite::Connection::open(home.join("state.db")).expect("the database");
    db.execute(
        "INSERT INTO workers (id, state, cwd, prompt, name, started_at, tool_calls, scratch, agent_role, backend_kind, session_id) \
         VALUES ('w-main', 'SUSPENDED', ?1, 'go', 'main chat', 1700000000000, 0, 0, 'focused', 'claude', 'w-main')",
        rusqlite::params![repo],
    )
    .expect("main chat");
    db.execute(
        "INSERT INTO workers (id, state, cwd, worktree_from, worktree_dir, branch, fork_base_sha, workspace_ready, prompt, name, \
         started_at, tool_calls, scratch, agent_role, backend_kind, session_id) \
         VALUES ('w-wt', 'SUSPENDED', ?2, ?1, ?2, 'eos/worker-1', ?3, 1, 'go', 'worktree worker', 1700000001000, 0, 0, 'worker', 'claude', 'w-wt')",
        rusqlite::params![repo, wt, fork],
    )
    .expect("worktree worker");
}

async fn one(app: &eos_app::App, target: &str) -> Duration {
    let began = Instant::now();
    let response = app.router().handle(Request::new(Method::Get, target, rig::dashboard(app))).await;
    let status = response.status;
    response.body.collect().await.expect("a body");
    assert_eq!(status, 200, "{target}");
    began.elapsed()
}

async fn burst(app: &eos_app::App, targets: &[String]) -> Duration {
    let began = Instant::now();
    let mut all = tokio::task::JoinSet::new();
    for target in targets {
        let (router, caller, target) = (app.router(), rig::dashboard(app), target.clone());
        all.spawn(async move { router.handle(Request::new(Method::Get, &target, caller)).await.body.collect().await });
    }
    while all.join_next().await.is_some() {}
    began.elapsed()
}

fn percentiles(mut times: Vec<Duration>) -> (Duration, Duration) {
    times.sort();
    let at = |p: f64| times[((times.len() - 1) as f64 * p).round() as usize];
    (at(0.5), at(0.9))
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn load() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "probe: needs GIT_PERF_ROOT"]
async fn git_routes_on_a_throwaway_repository() {
    let root = PathBuf::from(std::env::var("GIT_PERF_ROOT").expect("GIT_PERF_ROOT"));
    let root = root.canonicalize().expect("root");
    let repo = root.join("repo").to_string_lossy().into_owned();
    let wt = root.join("wt").to_string_lossy().into_owned();
    let fork = std::fs::read_to_string(root.join("fork_base")).expect("fork_base").trim().to_owned();

    let home = TempHome::new();
    let agents = ScriptedRuntime::unlogged();
    {
        let app = rig::build(home.path(), &agents);
        app.start().await.expect("starts");
        app.shutdown(Duration::from_secs(5)).await;
    }
    insert_workers(home.path(), &repo, &wt, &fork);
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let n = rounds();
    println!("LOAD start {}", load());

    for (who, dir) in [("w-main", &repo), ("w-wt", &wt)] {
        let c = enc(dir);
        let targets = vec![
            format!("/workers/{who}/diff"),
            format!("/workers/{who}/push-state"),
            format!("/workers/{who}/conflicts"),
            format!("/workers/{who}/try/state"),
            format!("/fs/branches?cwd={c}"),
            format!("/workers/{who}/changes"),
            format!("/workers/{who}/changes?patches=1"),
            format!("/fs/changes?cwd={c}"),
            format!("/fs/changes?cwd={c}&patches=1"),
            format!("/fs/changes?cwd={c}&base=auto&patches=1"),
            format!("/fs/branches?cwd={c}&remotes=1"),
        ];
        let chat_switch = &targets[..5];
        let short = |t: &str| t.replace(&c, "<dir>");

        // Cold: nothing watched, each round after what was shared has gone.
        let mut times = Vec::with_capacity(n);
        for _ in 0..n {
            tokio::time::sleep(SHARED_FOR).await;
            times.push(burst(&app, chat_switch).await);
        }
        let (p50, p90) = percentiles(times);
        println!("BURST cold {who:<6} p50 {p50:>9.2?} p90 {p90:>9.2?}  load {}", load());
        for target in &targets {
            let mut times = Vec::with_capacity(n);
            for _ in 0..n.min(5) {
                tokio::time::sleep(SHARED_FOR).await;
                times.push(one(&app, target).await);
            }
            let (p50, p90) = percentiles(times);
            println!("ROUTE cold {:<48} p50 {p50:>9.2?} p90 {p90:>9.2?}", short(target));
        }

        // Warm: the tree is watched, as the chat on screen is.
        let lease = json!({ "dir": dir, "clientId": "probe" }).to_string();
        let watch = Request::new(Method::Post, "/fs/git/watch", rig::dashboard(&app)).body(lease);
        assert_eq!(app.router().handle(watch).await.status, 200);
        tokio::time::sleep(Duration::from_secs(1)).await;
        burst(&app, chat_switch).await;
        let mut times = Vec::with_capacity(n);
        for _ in 0..n {
            times.push(burst(&app, chat_switch).await);
        }
        let (p50, p90) = percentiles(times);
        println!("BURST warm {who:<6} p50 {p50:>9.2?} p90 {p90:>9.2?}  load {}", load());
        for target in &targets {
            one(&app, target).await;
            let mut times = Vec::with_capacity(n);
            for _ in 0..n {
                times.push(one(&app, target).await);
            }
            let (p50, p90) = percentiles(times);
            println!("ROUTE warm {:<48} p50 {p50:>9.2?} p90 {p90:>9.2?}", short(target));
        }
    }
    println!("LOAD end {}", load());
    app.shutdown(Duration::from_secs(5)).await;
}
