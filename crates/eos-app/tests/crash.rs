//! Quitting and crashing at bad moments: the next start finds a consistent
//! data folder, chats that were working are parked as interrupted (not lost,
//! not doubled), and what was answered before the end is there.
//!
//! The kill -9 rounds are ignored (they take a while):
//! `cargo test -p eos-app --test crash -- --ignored kill_dash_nine`, or over
//! and over with `scripts/stress.sh -p eos-app -- --ignored kill_dash_nine`.
//! They kill only the child process the test itself started — a second run of
//! this test binary that drives the app until it is killed.

#[path = "support/rig.rs"]
mod rig;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use eos_runtime::http::Method;
use eos_testkit::agent::Turn;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(20);
/// Set in the child: the data folder it drives until it is killed.
const CHILD_HOME: &str = "EOS_CRASH_CHILD_HOME";

fn integrity(home: &Path) -> String {
    let db = rusqlite::Connection::open(home.join("state.db")).expect("the database opens");
    db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).expect("the check runs")
}

fn project() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("a folder");
    std::fs::write(dir.path().join("README.md"), "# project\n").expect("a file");
    let cwd = dir.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    (dir, cwd)
}

/// Every chat's rows after a restart: none is still working, and no row of
/// its transcript appears twice.
async fn consistent_after_restart(app: &eos_app::App) -> Vec<Value> {
    let (status, workers) = rig::call(app, Method::Get, "/workers", None).await;
    assert_eq!(status, 200, "{workers}");
    let workers = workers.as_array().cloned().unwrap_or_default();
    for worker in &workers {
        let id = worker["id"].as_str().expect("an id");
        assert_ne!(worker["state"], "WORKING", "{id} is parked, not left working");
        let (status, rows) =
            rig::call(app, Method::Get, &format!("/workers/{id}/events?limit=5000&order=asc"), None).await;
        assert_eq!(status, 200, "{id}: {rows}");
        let ids: Vec<i64> = rows.as_array().into_iter().flatten().filter_map(|r| r["id"].as_i64()).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]), "{id}: the transcript is in order, without repeats");
        // A message the user sent is recorded once, whatever happened around it.
        let mut sent: Vec<String> = rows
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["type"] == "user_message")
            .filter_map(|r| serde_json::from_str::<Value>(r["payload"].as_str()?).ok())
            .filter_map(|p| p["clientMsgId"].as_str().map(str::to_owned))
            .collect();
        let count = sent.len();
        sent.sort();
        sent.dedup();
        assert_eq!(sent.len(), count, "{id}: no message was recorded twice");
    }
    let (status, pages) = rig::call(app, Method::Get, "/api/pages", None).await;
    assert_eq!(status, 200, "every page still reads: {pages}");
    workers
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quitting_mid_turn_with_writes_in_flight_leaves_a_consistent_folder() {
    let home = TempHome::new();
    let (_folder, cwd) = project();
    let (chat, answered) = {
        let agents = ScriptedRuntime::new();
        let app = rig::build(home.path(), &agents);
        app.start().await.expect("starts");
        let mut frames = rig::Frames::new(rig::open_stream(&app, "topics=worker:*").await.expect("a stream"));
        // A turn that never ends by itself, and a message queued behind it.
        let _held = agents.script_held(Turn::reply("never said"));
        let chat = rig::focused_chat(&app, &cwd, "work on it").await;
        assert!(frames.until(WAIT, |f| rig::went(f, &chat, "WORKING")).await.is_some());
        let queued = json!({"text": "after that", "clientMsgId": "c-after", "queueWhenBusy": true});
        let (status, body) = rig::call(&app, Method::Post, &format!("/workers/{chat}/message"), Some(queued)).await;
        assert!(status < 300, "{body}");

        // Writes in flight while the app quits: each one answered or refused, none half-done.
        let app = std::sync::Arc::new(app);
        let writes: Vec<_> = (0..40)
            .map(|n| {
                let app = app.clone();
                tokio::spawn(async move {
                    let body = json!({"title": format!("Page {n}"), "body": "- [ ] x"});
                    let (status, made) = rig::call(&app, Method::Post, "/api/pages", Some(body)).await;
                    (status == 201).then(|| made["page"]["id"].as_str().unwrap_or_default().to_owned())
                })
            })
            .collect();
        let report = app.shutdown(Duration::from_secs(5)).await;
        assert!(report.clean(), "every module stopped in time: {report:?}");
        let mut answered = Vec::new();
        for write in writes {
            if let Ok(Some(id)) = write.await {
                answered.push(id);
            }
        }
        (chat, answered)
    };
    assert_eq!(integrity(home.path()), "ok");

    let agents = ScriptedRuntime::new();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts again");
    let workers = consistent_after_restart(&app).await;
    let row = workers.iter().find(|w| w["id"] == chat.as_str()).expect("the chat is still there");
    assert_eq!(row["state"], "SUSPENDED", "the working chat is parked as interrupted: {row}");
    let (_, queue) = rig::call(&app, Method::Get, &format!("/workers/{chat}/queue"), None).await;
    let waiting = queue["messages"].as_array().map_or(0, Vec::len);
    assert_eq!(waiting, 1, "the queued message waits, once: {queue}");
    let (_, pages) = rig::call(&app, Method::Get, "/api/pages", None).await;
    let listed: Vec<&str> = pages["pages"].as_array().into_iter().flatten().filter_map(|p| p["id"].as_str()).collect();
    for id in &answered {
        assert!(listed.contains(&id.as_str()), "page {id} was answered before the quit, so it is there");
    }
    app.shutdown(Duration::from_secs(5)).await;
    assert_eq!(integrity(home.path()), "ok");
}

/// The child: drives the app on `EOS_CRASH_CHILD_HOME` until it is killed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "run by kill_dash_nine_at_random_moments_recovers as its child"]
async fn child_workload() {
    let Ok(home) = std::env::var(CHILD_HOME) else { return };
    let (_folder, cwd) = project();
    let agents = ScriptedRuntime::unlogged();
    agents.otherwise(rig::turn_for);
    let app = std::sync::Arc::new(rig::build(Path::new(&home), &agents));
    app.start().await.expect("starts");
    println!("ready");
    let mut n = 0u64;
    let mut chats: Vec<String> = Vec::new();
    loop {
        n += 1;
        if chats.len() < 3 {
            chats.push(rig::focused_chat(&app, &cwd, "[long] begin").await);
        }
        let chat = chats[(n % chats.len() as u64) as usize].clone();
        let kind = rig::KINDS[(n % rig::KINDS.len() as u64) as usize];
        let message =
            json!({"text": format!("[{kind}] step {n}"), "clientMsgId": format!("c-{n}"), "queueWhenBusy": true});
        let page = json!({"title": format!("Page {n}"), "body": "- [ ] x"});
        let (app_a, app_b) = (app.clone(), app.clone());
        let chat_path = format!("/workers/{chat}/message");
        let _ = tokio::join!(
            rig::call(&app_a, Method::Post, &chat_path, Some(message)),
            rig::call(&app_b, Method::Post, "/api/pages", Some(page)),
        );
        if n.is_multiple_of(25) {
            let gone = chats.remove(0);
            rig::call(&app, Method::Delete, &format!("/workers/{gone}"), None).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "ten kill -9 rounds of a child process: see the top of this file"]
async fn kill_dash_nine_at_random_moments_recovers() {
    let home = TempHome::new();
    let mut rng = rig::Rng::new(std::env::var("EOS_CRASH_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7));
    let rounds: usize = std::env::var("EOS_CRASH_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    for round in 0..rounds {
        let mut child = Command::new(std::env::current_exe().expect("this test binary"))
            .args(["child_workload", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
            .env(CHILD_HOME, home.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the child starts");
        let stdout = child.stdout.take().expect("its output");
        let ready = tokio::task::spawn_blocking(move || {
            BufReader::new(stdout).lines().map_while(Result::ok).any(|line| line.contains("ready"))
        });
        assert!(
            tokio::time::timeout(WAIT, ready).await.is_ok_and(|r| r.unwrap_or(false)),
            "round {round}: the child came up"
        );
        let after = 200 + rng.below(2_800) as u64;
        tokio::time::sleep(Duration::from_millis(after)).await;
        // SIGKILL, to the child this test started and no one else.
        child.kill().expect("the child is killed");
        let _ = child.wait();

        assert_eq!(integrity(home.path()), "ok", "round {round}: killed after {after} ms");
        let agents = ScriptedRuntime::new();
        let app = rig::build(home.path(), &agents);
        app.start().await.unwrap_or_else(|e| panic!("round {round}: the app starts after a kill at {after} ms: {e}"));
        let workers = consistent_after_restart(&app).await;
        println!("round {round}: killed after {after} ms; {} chats, all parked or idle", workers.len());
        app.shutdown(Duration::from_secs(5)).await;
    }
}
