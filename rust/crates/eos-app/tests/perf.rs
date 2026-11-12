//! Speed budgets of the composed app, on a data folder the size of a real one
//! (130 chats, 180,000 rows, one chat of 25,000 with subagents): cold start,
//! the chat list, a 500-row transcript page, the conversation-wide subagent
//! list, a burst of 1,000 agent events from the engine to rows and stream,
//! and one event fanned out to 100 subscribers.
//!
//! Ignored: they assert time. `scripts/perf.sh` runs them in release, one at
//! a time; run them on a machine that is not busy with other builds.

#[path = "support/rig.rs"]
mod rig;

use std::path::Path;
use std::time::{Duration, Instant};

use eos_contracts::AgentEvent;
use eos_runtime::http::Method;
use eos_testkit::agent::{Turn, events};
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::json;

const CHATS: usize = 130;
const BIG_CHAT_ROWS: usize = 25_000;
const ROWS: usize = 180_000;

fn text(n: usize, len: usize) -> String {
    const WORDS: [&str; 12] =
        ["the", "chat", "reads", "a", "file", "and", "writes", "tests", "for", "each", "small", "change"];
    let mut out = String::with_capacity(len + 16);
    let mut i = n;
    while out.len() < len {
        out.push_str(WORDS[i % WORDS.len()]);
        out.push(' ');
        i = i.wrapping_mul(31).wrapping_add(7);
    }
    out
}

/// The `n`-th row of a chat, shaped like the real mix (activity, messages
/// with text, reasoning, tool calls and results, turns, states), with a
/// subagent run every 200 rows.
fn row(n: usize) -> (&'static str, String) {
    let call = format!("toolu_{n:06}");
    let at = n % 200;
    let payload = match (at, n % 10) {
        (0, _) => {
            json!({"type": "message", "role": "assistant", "blocks": [{"type": "tool_call", "callId": call, "name": "Task", "input": {"description": "look", "prompt": text(n, 400)}}]})
        }
        (1, _) => {
            json!({"type": "subagent_started", "callId": format!("toolu_{:06}", n - 1), "agentId": format!("a{n}"), "background": false, "description": "look"})
        }
        (2..=20, _) => {
            json!({"type": "message", "role": "assistant", "blocks": [{"type": "tool_call", "callId": call, "name": "Read", "input": {"file_path": "src/lib.rs"}, "parentCallId": format!("toolu_{:06}", n - at)}]})
        }
        (21, _) => {
            json!({"type": "subagent_completed", "agentId": format!("a{}", n - 20), "callId": format!("toolu_{:06}", n - 21), "status": "completed", "result": text(n, 6_000)})
        }
        (_, 0..=4) => {
            json!({"type": "activity", "kind": "tool_started", "callId": call, "toolName": "Read", "summary": text(n, 2_000)})
        }
        (_, 5) => {
            json!({"type": "message", "role": "assistant", "blocks": [{"type": "reasoning", "text": text(n, 1_200), "blockId": format!("r{n}:0")}]})
        }
        (_, 6) => {
            json!({"type": "message", "role": "tool", "blocks": [{"type": "tool_result", "callId": call, "isError": false, "content": text(n, 3_000)}]})
        }
        (_, 7) => {
            json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": text(n, 800), "blockId": format!("m{n}:0")}]})
        }
        (_, 8) => json!({"type": "turn", "phase": "ended"}),
        _ => return ("state", json!({"state": "IDLE", "from": "WORKING", "reason": "turn_end"}).to_string()),
    };
    ("agent_event", payload.to_string())
}

/// Fills a migrated data folder with chats and rows, straight into the database.
fn fill(home: &Path, cwd: &str) {
    let mut db = rusqlite::Connection::open(home.join("state.db")).expect("the database");
    let tx = db.transaction().expect("a transaction");
    let per_chat = (ROWS - BIG_CHAT_ROWS) / (CHATS - 1);
    for chat in 0..CHATS {
        let id = format!("w-perf{chat:04}");
        let started = 1_700_000_000_000_i64 + chat as i64 * 60_000;
        tx.execute(
            "INSERT INTO workers (id, state, cwd, prompt, name, started_at, tool_calls, scratch, agent_role, backend_kind, session_id) \
             VALUES (?1, 'SUSPENDED', ?2, 'go', ?3, ?4, 0, 0, 'focused', 'claude', ?1)",
            rusqlite::params![id, cwd, format!("Chat {chat}"), started],
        )
        .expect("a worker");
        let rows = if chat == 0 { BIG_CHAT_ROWS } else { per_chat };
        let mut insert = tx
            .prepare_cached("INSERT INTO events (worker_id, ts, type, payload) VALUES (?1, ?2, ?3, ?4)")
            .expect("sql");
        for n in 0..rows {
            let (kind, payload) = row(n);
            insert.execute(rusqlite::params![id, started + n as i64, kind, payload]).expect("a row");
        }
    }
    tx.commit().expect("committed");
}

/// A data folder of real size: migrated by a first start, then filled.
async fn sized() -> (TempHome, tempfile::TempDir, String) {
    let home = TempHome::new();
    let folder = tempfile::tempdir().expect("a folder");
    let cwd = folder.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    {
        let agents = ScriptedRuntime::unlogged();
        let app = rig::build(home.path(), &agents);
        app.start().await.expect("starts");
        app.shutdown(Duration::from_secs(5)).await;
    }
    fill(home.path(), &cwd);
    (home, folder, cwd)
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

async fn timed(app: &eos_app::App, label: &str, target: &str, rounds: usize) -> Duration {
    let mut times = Vec::with_capacity(rounds);
    let mut bytes = 0;
    for _ in 0..rounds {
        let began = Instant::now();
        // The whole answer, also when it leaves in slices.
        let response =
            app.router().handle(eos_runtime::http::Request::new(Method::Get, target, rig::dashboard(app))).await;
        let status = response.status;
        let body = response.body.collect().await.expect("a body");
        times.push(began.elapsed());
        assert_eq!(status, 200, "{label}");
        bytes = body.len();
    }
    times.sort();
    let p99 = percentile(&times, 0.99);
    println!("{label:<40} p50 {:>9.2?}  p99 {p99:>9.2?}  {:>6} KB", percentile(&times, 0.5), bytes / 1024);
    p99
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "asserts time: scripts/perf.sh"]
async fn cold_start_and_the_hot_reads_stay_inside_their_budgets() {
    let (home, _folder, _cwd) = sized().await;
    let agents = ScriptedRuntime::unlogged();
    let began = Instant::now();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let ready = began.elapsed();
    println!("cold start on {ROWS} rows: {ready:.2?}");
    assert!(ready < Duration::from_millis(1_500), "cold start {ready:?} (budget 1.5 s)");

    let list = timed(&app, "GET /workers", "/workers", 200).await;
    assert!(list < Duration::from_millis(25), "the chat list (budget 25 ms p99)");
    let page = timed(&app, "GET /workers/{id}/events?limit=500", "/workers/w-perf0000/events?limit=500", 200).await;
    assert!(page < Duration::from_millis(40), "a 500-row page (budget 40 ms p99)");
    let asc = timed(&app, "  … order=asc", "/workers/w-perf0000/events?limit=500&order=asc", 200).await;
    assert!(asc < Duration::from_millis(40), "the oldest 500-row page (budget 40 ms p99)");
    let subagents = timed(&app, "GET /workers/{id}/subagent-events", "/workers/w-perf0000/subagent-events", 30).await;
    assert!(subagents < Duration::from_millis(150), "the subagent list of a 25,000-row chat (budget 150 ms p99)");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "asserts time: scripts/perf.sh"]
async fn a_burst_of_agent_events_reaches_rows_and_the_stream_in_time() {
    let (home, _folder, cwd) = sized().await;
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
    let chat = rig::focused_chat(&app, &cwd, "hi").await;
    assert!(frames.until(Duration::from_secs(10), |f| rig::went(f, &chat, "IDLE")).await.is_some());

    // 1,000 events in one turn: text, tool calls and results.
    let body: Vec<AgentEvent> = (0..1_000)
        .map(|n| match n % 3 {
            0 => events::text(&text(n, 300), &format!("m{n}:0")),
            1 => events::tool_call(&format!("toolu_b{n}"), "Read", Default::default()),
            _ => events::tool_result(&format!("toolu_b{}", n - 1), &text(n, 500), false),
        })
        .collect();
    agents.script(Turn::of(body));
    let began = Instant::now();
    let (status, _) =
        rig::call(&app, Method::Post, &format!("/workers/{chat}/message"), Some(json!({"text": "go"}))).await;
    assert!(status < 300);
    let idle = frames.until(Duration::from_secs(30), |f| rig::went(f, &chat, "IDLE")).await;
    let took = began.elapsed();
    assert!(idle.is_some(), "the turn ends");
    let (_, rows) = rig::call(&app, Method::Get, &format!("/workers/{chat}/events?limit=5000"), None).await;
    let count = rows.as_array().map_or(0, Vec::len);
    println!("1,000 agent events → {count} rows and frames, turn over in {took:.2?}");
    assert!(count > 1_000, "every event was recorded");
    assert!(took < Duration::from_secs(2), "the burst took {took:?} (budget 2 s)");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "asserts time: scripts/perf.sh"]
async fn one_thousand_events_fan_out_to_a_hundred_subscribers_in_time() {
    let home = TempHome::new();
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let mut subscribers = Vec::new();
    for _ in 0..100 {
        let mut frames = rig::Frames::new(rig::open_stream(&app, "topics=pages:*").await.expect("a stream"));
        let hello = frames.next(Duration::from_secs(5)).await.expect("hello");
        assert!(hello.get("epoch").is_some());
        subscribers.push(frames);
    }
    // The bus is what every feature publishes on; the pages topic is one of them.
    let began = Instant::now();
    for n in 0..1_000 {
        let payload = json!({"pageId": format!("pg-{n:012}"), "rev": n, "by": "user"}).to_string();
        app.runtime().kernel.bus.publish_raw("pages:change", None, payload.into_bytes().into());
    }
    let written = began.elapsed();
    let readers: Vec<_> = subscribers
        .into_iter()
        .map(|mut frames| {
            tokio::spawn(async move {
                let mut got = 0;
                while got < 1_000 {
                    match frames.next(Duration::from_secs(20)).await {
                        Some(frame) if frame["reason"] == "pages:change" => got += 1,
                        Some(_) => {}
                        None => break,
                    }
                }
                got
            })
        })
        .collect();
    let mut delivered = 0;
    for reader in readers {
        delivered += reader.await.unwrap_or(0);
    }
    let took = began.elapsed();
    println!("1,000 events published in {written:.2?}; {delivered} frames to 100 subscribers in {took:.2?}");
    assert_eq!(delivered, 100_000, "every subscriber got every frame");
    assert!(took < Duration::from_secs(2), "fan-out took {took:?} (budget 2 s)");
    app.shutdown(Duration::from_secs(5)).await;
}
