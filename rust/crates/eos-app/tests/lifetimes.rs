//! Per-item state ends with the item, in the whole app: sessions started and
//! stopped, stream subscribers that come and go, terminals opened and
//! closed, views presented and removed, jobs that start and end. Each run
//! measures the process after a warm-up and again after many more cycles:
//! memory, descriptors, threads and tasks must come back.
//!
//! The cycle tests are ignored (they take a while and measure the process
//! they run in): `scripts/perf.sh` runs them, one at a time, with a shell
//! that reads no profile (`SHELL=/bin/sh`).

#[path = "support/rig.rs"]
mod rig;

use std::time::Duration;

use eos_runtime::http::Method;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::json;

const WAIT: Duration = Duration::from_secs(20);

/// What a cycle test allows to remain after the warm-up.
struct Budget {
    /// Bytes held out by the allocator (what a leak grows).
    malloc_kb: u64,
    /// The system's count, which also holds what the allocator keeps for reuse.
    footprint_kb: u64,
    fds: usize,
    threads: usize,
    tasks: usize,
}

const BUDGET: Budget = Budget { malloc_kb: 4 * 1024, footprint_kb: 16 * 1024, fds: 4, threads: 4, tasks: 8 };

fn judge(what: &str, warm: &rig::Sample, end: &rig::Sample) {
    println!("{what}: after warm-up {warm:?}");
    println!("{what}: at the end    {end:?}");
    assert!(
        end.malloc_kb <= warm.malloc_kb + BUDGET.malloc_kb,
        "{what}: allocated memory grew {} → {} KB",
        warm.malloc_kb,
        end.malloc_kb
    );
    assert!(
        end.footprint_kb <= warm.footprint_kb + BUDGET.footprint_kb,
        "{what}: footprint grew {} → {} KB",
        warm.footprint_kb,
        end.footprint_kb
    );
    assert!(end.fds <= warm.fds + BUDGET.fds, "{what}: descriptors grew {} → {}", warm.fds, end.fds);
    assert!(end.threads <= warm.threads + BUDGET.threads, "{what}: threads grew {} → {}", warm.threads, end.threads);
    assert!(end.tasks <= warm.tasks + BUDGET.tasks, "{what}: tasks grew {} → {}", warm.tasks, end.tasks);
}

/// Lets what a cycle left to finish (a reaped process, a dropped stream's
/// task, a chat's naming timer that fires after its chat is gone, 5 s) finish
/// before measuring: the measure is taken once tasks, descriptors and threads
/// held still for 6 s, longer than any such timer (40 s at most).
async fn settled(app: &eos_app::App, agents: &ScriptedRuntime) -> rig::Sample {
    let now = || (tokio::runtime::Handle::current().metrics().num_alive_tasks(), rig::fds(), rig::threads());
    let mut last = now();
    let mut held = 0;
    for _ in 0..160 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let current = now();
        held = if current == last { held + 1 } else { 0 };
        last = current;
        if held >= 24 {
            break;
        }
    }
    rig::sample(app, agents, 0.0)
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a folder");
    std::fs::write(dir.path().join("README.md"), "# project\n").expect("a file");
    dir
}

fn cwd(dir: &tempfile::TempDir) -> String {
    dir.path().canonicalize().expect("the folder").to_string_lossy().into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_kind_of_turn_runs_through_the_app_and_ends_idle() {
    let home = TempHome::new();
    let folder = project();
    let agents = ScriptedRuntime::new();
    agents.otherwise(rig::turn_for);
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));

    let id = rig::focused_chat(&app, &cwd(&folder), "[reply] hello").await;
    assert!(frames.until(WAIT, |f| rig::went(f, &id, "IDLE")).await.is_some(), "the first turn ends");
    for kind in rig::KINDS {
        let (status, body) = rig::call(
            &app,
            Method::Post,
            &format!("/workers/{id}/message"),
            Some(json!({"text": format!("[{kind}] go")})),
        )
        .await;
        assert!(status < 300, "{kind}: {status} {body}");
        assert!(frames.until(WAIT, |f| rig::went(f, &id, "IDLE")).await.is_some(), "{kind}: the turn ends");
    }
    agents.settled().await;
    // The "big" turn's idle edge compacts the chat, and the IDLE that ends the
    // compaction can be the one a later kind's wait took: that kind's turn,
    // queued behind it, may still be running here.
    let deadline = tokio::time::Instant::now() + WAIT;
    let row = loop {
        let (_, row) = rig::call(&app, Method::Get, &format!("/workers/{id}"), None).await;
        if row["state"] == "IDLE" || tokio::time::Instant::now() > deadline {
            break row;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(row["state"], "IDLE", "{row}");
    agents.settled().await;
    let (_, rows) = rig::call(&app, Method::Get, &format!("/workers/{id}/events?limit=5000&order=asc"), None).await;
    let count = rows.as_array().map_or(0, Vec::len);
    assert!(count > 40, "the turns were logged: {count} rows");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "10,000 cycles that measure the process: scripts/perf.sh"]
async fn ten_thousand_sessions_start_and_stop() {
    let home = TempHome::new();
    let folder = project();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let cwd = cwd(&folder);
    let cycle = |n: usize| {
        let (app, cwd) = (&app, cwd.clone());
        async move {
            let (status, created) =
                rig::call(app, Method::Post, "/orchestrators", Some(json!({"mode": "focused", "cwd": cwd}))).await;
            assert_eq!(status, 201, "cycle {n}: {created}");
            let id = created["id"].as_str().expect("an id").to_owned();
            let (status, gone) = rig::call(app, Method::Delete, &format!("/workers/{id}"), None).await;
            assert_eq!(status, 200, "cycle {n}: {gone}");
        }
    };
    for n in 0..1_000 {
        cycle(n).await;
    }
    let warm = settled(&app, &agents).await;
    for n in 1_000..10_000 {
        cycle(n).await;
    }
    let end = settled(&app, &agents).await;
    assert_eq!(eos_core::agent::AgentRuntime::live(&agents), 0, "every session ended");
    let (_, workers) = rig::call(&app, Method::Get, "/workers", None).await;
    assert_eq!(workers.as_array().map_or(0, Vec::len), 0, "every row is gone");
    judge("sessions", &warm, &end);
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "10,000 cycles that measure the process: scripts/perf.sh"]
async fn ten_thousand_stream_subscribers_come_and_go() {
    let home = TempHome::new();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    // Something to replay: a resume from the start of the ring.
    for n in 0..50 {
        rig::call(&app, Method::Post, "/api/pages", Some(json!({"title": format!("Page {n}"), "body": "x"}))).await;
    }
    let mut epoch = String::new();
    let cycle = |n: usize, epoch: String| {
        let app = &app;
        async move {
            let query = match n % 3 {
                0 => String::new(),
                1 => format!("since={epoch}-0"),
                _ => "topics=pages:*".to_owned(),
            };
            let mut frames = rig::Frames::new(rig::open_stream(app, &query).await.expect("a stream"));
            let first = frames.next(WAIT).await.expect("a first frame");
            first["epoch"].as_str().map(str::to_owned)
        }
    };
    for n in 0..1_000 {
        if let Some(e) = cycle(n, epoch.clone()).await {
            epoch = e;
        }
    }
    let warm = settled(&app, &agents).await;
    for n in 1_000..10_000 {
        cycle(n, epoch.clone()).await;
    }
    let end = settled(&app, &agents).await;
    judge("stream subscribers", &warm, &end);
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "1,000 terminals that measure the process: scripts/perf.sh"]
async fn a_thousand_terminals_open_and_close() {
    let home = TempHome::new();
    let folder = project();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let cwd = cwd(&folder);
    let mut frames = rig::Frames::new(rig::open_stream(&app, "topics=pty:*").await.expect("a stream"));
    let mut cycle = async |n: usize| {
        let (status, created) =
            rig::call(&app, Method::Post, "/pty", Some(json!({"cwd": cwd, "cols": 80, "rows": 24}))).await;
        assert_eq!(status, 200, "terminal {n}: {created}");
        let id = created["sessionId"].as_str().expect("an id").to_owned();
        rig::call(&app, Method::Post, &format!("/pty/{id}/input"), Some(json!({"data": "echo hi\r"}))).await;
        let (status, closed) = rig::call(&app, Method::Delete, &format!("/pty/{id}"), None).await;
        assert!(status < 300, "terminal {n}: {status} {closed}");
        let exited =
            frames.until(WAIT, |f| f["reason"] == "pty:exit" && f["payload"]["sessionId"] == id.as_str()).await;
        assert!(exited.is_some(), "terminal {n} ends");
    };
    for n in 0..100 {
        cycle(n).await;
    }
    let warm = settled(&app, &agents).await;
    for n in 100..1_000 {
        cycle(n).await;
    }
    let end = settled(&app, &agents).await;
    let (_, list) = rig::call(&app, Method::Get, "/pty", None).await;
    assert_eq!(list.as_array().map_or(0, Vec::len), 0, "no terminal is left: {list}");
    judge("terminals", &warm, &end);
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "2,000 watches that measure the process: scripts/perf.sh"]
async fn two_thousand_folder_and_git_watches_come_and_go() {
    let home = TempHome::new();
    let folder = project();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let dir = cwd(&folder);
    std::process::Command::new("git").args(["init", "-q", &dir]).status().expect("git");
    let cycle = |n: usize| {
        let (app, dir) = (&app, dir.clone());
        async move {
            let client = format!("tab-{n}");
            let watch = json!({"root": dir, "dir": dir, "clientId": client});
            let (status, body) = rig::call(app, Method::Post, "/fs/watch", Some(watch.clone())).await;
            assert_eq!(status, 200, "watch {n}: {body}");
            let git = json!({"dir": dir, "clientId": client});
            let (status, body) = rig::call(app, Method::Post, "/fs/git/watch", Some(git.clone())).await;
            assert_eq!(status, 200, "git watch {n}: {body}");
            let (status, body) = rig::call(app, Method::Post, "/fs/unwatch", Some(watch)).await;
            assert_eq!(status, 200, "unwatch {n}: {body}");
            let (status, body) = rig::call(app, Method::Post, "/fs/git/unwatch", Some(git)).await;
            assert_eq!(status, 200, "git unwatch {n}: {body}");
        }
    };
    for n in 0..200 {
        cycle(n).await;
    }
    let warm = settled(&app, &agents).await;
    for n in 200..2_000 {
        cycle(n).await;
    }
    let end = settled(&app, &agents).await;
    judge("watches", &warm, &end);
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "2,000 jobs that measure the process: scripts/perf.sh"]
async fn two_thousand_jobs_start_end_and_are_cleared() {
    let home = TempHome::new();
    let folder = project();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
    let chat = rig::focused_chat(&app, &cwd(&folder), "[reply] hi").await;
    assert!(frames.until(WAIT, |f| rig::went(f, &chat, "IDLE")).await.is_some());
    let mut cycle = async |n: usize| {
        let (status, body) =
            rig::call(&app, Method::Post, &format!("/workers/{chat}/terminal"), Some(json!({"command": "true"}))).await;
        assert_eq!(status, 200, "command {n}: {body}");
        let done = frames.until(WAIT, |f| f["reason"] == "terminal:done").await;
        assert!(done.is_some(), "command {n} ends");
        if n % 10 == 9 {
            let (status, body) = rig::call(&app, Method::Post, "/api/jobs/clear", None).await;
            assert_eq!(status, 200, "clear {n}: {body}");
        }
    };
    // Each command adds rows to the chat's log: the warm-up runs until the log
    // outgrows the database connections' page caches (2 MB each), which then
    // hold steady while the log keeps growing.
    for n in 0..1_000 {
        cycle(n).await;
    }
    let warm = settled(&app, &agents).await;
    for n in 1_000..2_000 {
        cycle(n).await;
    }
    let end = settled(&app, &agents).await;
    let (_, jobs) = rig::call(&app, Method::Get, "/api/jobs", None).await;
    assert_eq!(jobs["jobs"].as_array().map_or(0, Vec::len), 0, "every job was cleared: {jobs}");
    judge("jobs", &warm, &end);
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "2,000 views that measure the process: scripts/perf.sh"]
async fn two_thousand_views_are_presented_and_removed_with_their_chats() {
    let home = TempHome::new();
    let folder = project();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "topics=worker:*").await.expect("a stream"));
    let untrusted = app.callers().classify(None);
    let mut chat_with_views = async |round: usize| {
        let chat = rig::focused_chat(&app, &cwd(&folder), "[reply] hi").await;
        assert!(frames.until(WAIT, |f| rig::went(f, &chat, "IDLE")).await.is_some());
        let mut views = Vec::new();
        for n in 0..20 {
            let input = json!({"input": {"title": format!("View {round}.{n}"), "ui": "<Text>hello</Text>", "summary": "hello"}});
            let request = eos_runtime::http::Request::new(Method::Post, "/api/genui/views", untrusted.clone())
                .header("x-eos-agent-id", &chat)
                .header("content-type", "application/json")
                .body(input.to_string());
            let response = app.router().handle(request).await;
            let status = response.status;
            let body = response.body.collect().await.unwrap_or_default();
            assert_eq!(status, 201, "view {round}.{n}: {}", String::from_utf8_lossy(&body));
            let view: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            views.push(view["viewId"].as_str().expect("a view id").to_owned());
        }
        let (status, body) = rig::call(&app, Method::Delete, &format!("/workers/{chat}"), None).await;
        assert_eq!(status, 200, "{body}");
        for view in views {
            let (status, _) = rig::call(&app, Method::Get, &format!("/api/genui/views/{view}"), None).await;
            assert_eq!(status, 404, "view {view} went with its chat");
        }
    };
    for round in 0..10 {
        chat_with_views(round).await;
    }
    let warm = settled(&app, &agents).await;
    for round in 10..100 {
        chat_with_views(round).await;
    }
    let end = settled(&app, &agents).await;
    judge("views", &warm, &end);
    app.shutdown(Duration::from_secs(5)).await;
}
