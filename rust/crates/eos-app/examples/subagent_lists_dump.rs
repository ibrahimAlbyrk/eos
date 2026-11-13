//! What the core answers for every chat's conversation-wide lists, for the
//! parity check against the dashboard's own derivation
//! (`rust/tools/subagent-lists-vectors/parity.mjs`).
//!
//!   cargo run --release -p eos-app --example subagent_lists_dump -- <data folder> <out dir>
//!
//! Run it on a copy of a data folder, with an isolated `HOME`. For each chat
//! (active and archived) it writes `<out>/<n>.json`: the worker row, today's
//! `/subagent-events` answer, the `/subagents` and `/artifacts` summaries and
//! every subagent's `/subagents/:callId/events` rows. `<out>/sizes.jsonl` holds
//! bytes and core times per chat (the first summary read includes reading the
//! chat's log in). Reads only through the router (GET); the bodies stay in
//! `<out>`, nothing is printed but counts.

use std::io::Write as _;
use std::time::{Duration, Instant};

use eos_app::{App, Options};
use eos_runtime::http::{Method, Request};
use serde_json::{Value, json};

async fn get(app: &App, target: &str) -> (Value, usize, f64) {
    let caller = app.callers().classify(Some(app.callers().ui_token()));
    let began = Instant::now();
    let response = app.router().handle(Request::new(Method::Get, target, caller)).await;
    let status = response.status;
    let body = response.body.collect().await.map(|b| b.to_vec()).unwrap_or_default();
    let ms = began.elapsed().as_secs_f64() * 1e3;
    assert_eq!(status, 200, "{target}");
    (serde_json::from_slice(&body).unwrap_or(Value::Null), body.len(), ms)
}

/// Bytes and the best of `n` core times.
async fn best(app: &App, target: &str, n: usize) -> (Value, usize, f64) {
    let mut out = (Value::Null, 0, f64::MAX);
    for _ in 0..n {
        let (body, bytes, ms) = get(app, target).await;
        if ms < out.2 {
            out = (body, bytes, ms);
        }
    }
    out
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [home, out] = [&args[0], &args[1]];
    let out = std::path::PathBuf::from(out);
    std::fs::create_dir_all(&out).expect("out dir");
    let app = App::build(Options::new(home)).expect("build");
    app.start().await.expect("start");
    app.runtime().lifecycle.deferred_done().await;

    let mut workers: Vec<Value> = Vec::new();
    for list in ["/workers", "/workers/archived"] {
        let (body, _, _) = get(&app, list).await;
        workers.extend(body.as_array().cloned().unwrap_or_default());
    }
    let mut sizes = std::fs::File::create(out.join("sizes.jsonl")).expect("file");
    let mut chats = 0;
    for (n, w) in workers.iter().enumerate() {
        let Some(id) = w["id"].as_str() else { continue };
        let (worker, _, _) = get(&app, &format!("/workers/{id}")).await;
        let (_, first_sub_bytes, first_sub_ms) = get(&app, &format!("/workers/{id}/subagents")).await;
        let (events, events_bytes, events_ms) = best(&app, &format!("/workers/{id}/subagent-events"), 3).await;
        let (subagents, sub_bytes, sub_ms) = best(&app, &format!("/workers/{id}/subagents"), 3).await;
        let (artifacts, art_bytes, art_ms) = best(&app, &format!("/workers/{id}/artifacts"), 3).await;
        let mut own = serde_json::Map::new();
        let mut own_bytes = Vec::new();
        for s in subagents["subagents"].as_array().into_iter().flatten() {
            for run in s["runs"].as_array().into_iter().flatten() {
                let Some(call) = run["toolUseId"].as_str() else { continue };
                let (rows, bytes, ms) = get(&app, &format!("/workers/{id}/subagents/{call}/events")).await;
                own_bytes.push(json!({"bytes": bytes, "ms": ms}));
                own.insert(call.to_owned(), rows);
            }
        }
        let record = json!({
            "worker": worker, "subagentEvents": events, "subagents": subagents["subagents"],
            "artifacts": artifacts["artifacts"], "subagentRows": own,
        });
        std::fs::write(out.join(format!("{n}.json")), serde_json::to_vec(&record).expect("json")).expect("write");
        let _ = writeln!(
            sizes,
            "{}",
            json!({
                "n": n,
                "subagentEvents": {"bytes": events_bytes, "rows": events.as_array().map_or(0, Vec::len), "ms": events_ms},
                "subagentsFirst": {"bytes": first_sub_bytes, "ms": first_sub_ms},
                "subagents": {"bytes": sub_bytes, "count": subagents["subagents"].as_array().map_or(0, Vec::len), "ms": sub_ms},
                "artifacts": {"bytes": art_bytes, "ms": art_ms},
                "subagentRows": own_bytes,
            })
        );
        chats += 1;
    }
    eprintln!("{chats} chats written");
    app.shutdown(Duration::from_secs(5)).await;
}
