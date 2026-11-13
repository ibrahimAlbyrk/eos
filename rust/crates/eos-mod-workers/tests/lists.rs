//! A conversation's subagents and artifacts as summaries, and one subagent's
//! rows, through the routes: equal to what the dashboard derives today from the
//! same log (`rust/fixtures/subagent-lists/vectors.json`), kept current by the
//! log's appends, caught up after rows another build wrote, closed to the phone.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::WorkerEventType;
use eos_mod_workers::WorkersModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeModelCatalog, TempStore};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    boot_prompt_offset: u32,
    rows: Vec<Row>,
    expected: Value,
}

#[derive(Deserialize)]
struct Row {
    id: i64,
    ts: i64,
    #[serde(rename = "type")]
    kind: String,
    payload: Option<String>,
}

fn vectors() -> Vec<Case> {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/subagent-lists/vectors.json"));
    let v: Vectors = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v.vectors
}

fn runtime(temp: &TempStore) -> Runtime {
    let module = Arc::new(WorkersModule::new(
        temp.port(),
        Arc::new(FakeModelCatalog::default()),
        Arc::new(eos_testkit::FakeClock::new()),
    ));
    Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).unwrap()
}

fn sql(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The case's worker and log, written as another build would (no facts).
fn seed(temp: &TempStore, case: &Case) {
    let parent = if case.boot_prompt_offset == 1 { "'o-1'" } else { "NULL" };
    temp.exec(&format!(
        "INSERT INTO workers (id, state, prompt, parent_id, started_at, tool_calls, scratch) VALUES ('w-T', 'IDLE', 'the task', {parent}, 1, 0, 0)"
    ));
    let mut text = String::from("BEGIN;");
    for r in &case.rows {
        let payload = r.payload.as_deref().map_or("NULL".to_owned(), sql);
        text.push_str(&format!(
            "INSERT INTO events (id, worker_id, ts, type, payload) VALUES ({}, 'w-T', {}, {}, {payload});",
            r.id,
            r.ts,
            sql(&r.kind)
        ));
    }
    text.push_str("COMMIT;");
    temp.exec(&text);
}

async fn get(runtime: &Runtime, target: &str, caller: Caller) -> (u16, Value) {
    let res = runtime.router.handle(Request::new(Method::Get, target, caller)).await;
    let status = res.status;
    let body = res.body.collect().await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_summaries_are_what_the_dashboard_derives_from_the_same_log() {
    for case in vectors() {
        let temp = TempStore::new();
        seed(&temp, &case);
        let rt = runtime(&temp);
        let (status, subagents) = get(&rt, "/workers/w-T/subagents", Caller::DASHBOARD).await;
        assert_eq!(status, 200, "{}", case.name);
        assert_eq!(subagents["subagents"], case.expected["subagents"], "{}", case.name);
        let (_, artifacts) = get(&rt, "/workers/w-T/artifacts", Caller::DASHBOARD).await;
        assert_eq!(artifacts["artifacts"], case.expected["artifacts"], "{}", case.name);

        // One subagent's rows are some of today's whole answer, in its order.
        let (_, all) = get(&rt, "/workers/w-T/subagent-events", Caller::DASHBOARD).await;
        let all = all.as_array().unwrap();
        for subagent in case.expected["subagents"].as_array().unwrap() {
            let call = subagent["toolUseId"].as_str().unwrap();
            let (status, own) = get(&rt, &format!("/workers/w-T/subagents/{call}/events"), Caller::DASHBOARD).await;
            assert_eq!(status, 200);
            let own = own.as_array().unwrap();
            assert!(!own.is_empty(), "{}: {call}", case.name);
            let mut from = 0;
            for row in own {
                let at =
                    all[from..].iter().position(|r| r == row).unwrap_or_else(|| panic!("{}: {call} {row}", case.name));
                from += at + 1;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn appends_keep_the_summaries_current() {
    let temp = TempStore::new();
    let case = vectors().into_iter().next().unwrap();
    seed(&temp, &case);
    let rt = runtime(&temp);
    let (_, before) = get(&rt, "/workers/w-T/subagents", Caller::DASHBOARD).await;
    let count = before["subagents"].as_array().unwrap().len();

    let launch = json!({"type": "message", "role": "assistant", "blocks": [
        {"type": "tool_call", "callId": "new-1", "name": "Agent", "spawnsSubagent": true, "input": {"description": "Fresh"}}
    ]})
    .to_string();
    temp.store
        .write_blocking(move |tx, _| {
            tx.events().append("w-T", 1_800_000_000_000, WorkerEventType::AgentEvent, Some(&launch))
        })
        .unwrap();
    assert_eq!(
        temp.count("SELECT count(*) FROM conversation_list_facts WHERE facts LIKE '%new-1%'"),
        1,
        "the append path"
    );
    let (_, after) = get(&rt, "/workers/w-T/subagents", Caller::DASHBOARD).await;
    let after = after["subagents"].as_array().unwrap();
    assert_eq!(after.len(), count + 1);
    assert_eq!(
        (after[count]["description"].as_str(), after[count]["status"].as_str()),
        (Some("Fresh"), Some("running"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_worker_or_call_has_none_and_the_phone_is_refused() {
    let temp = TempStore::new();
    let rt = runtime(&temp);
    assert_eq!(get(&rt, "/workers/w-NONE/subagents", Caller::DASHBOARD).await, (200, json!({"subagents": []})));
    assert_eq!(get(&rt, "/workers/w-NONE/artifacts", Caller::DASHBOARD).await, (200, json!({"artifacts": []})));
    assert_eq!(get(&rt, "/workers/w-NONE/subagents/c-1/events", Caller::DASHBOARD).await, (200, json!([])));

    let reference = rt.router.access_of(Method::Get, "/workers/w-1/subagent-events").unwrap();
    assert!(reference.phone.is_none(), "not to the phone");
    for target in ["/workers/w-1/subagents", "/workers/w-1/subagents/c-1/events", "/workers/w-1/artifacts"] {
        assert_eq!(rt.router.access_of(Method::Get, target), Some(reference), "{target} as /subagent-events");
    }
}
