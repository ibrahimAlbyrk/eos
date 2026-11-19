//! The module on its own: the real store over the seeded rows, no app around it.

use std::sync::Arc;

use eos_mod_workers::WorkersModule;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeModelCatalog, TempStore};
use serde_json::Value;

fn runtime(temp: &TempStore) -> Runtime {
    let module = Arc::new(WorkersModule::new(
        temp.port(),
        Arc::new(FakeModelCatalog::default()),
        Arc::new(eos_testkit::FakeClock::new()),
    ));
    Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes")
}

async fn get(runtime: &Runtime, target: &str, caller: Caller) -> (u16, Value) {
    let res = runtime.router.handle(Request::new(Method::Get, target, caller)).await;
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_leave_archived_chats_out_and_brief_rows_clip_the_prompt() {
    let temp = TempStore::seeded("/sandbox");
    let long = "word ".repeat(100);
    temp.exec(&format!("UPDATE workers SET prompt = '{long}' WHERE id = 'w-LONG'"));
    let runtime = runtime(&temp);

    let (status, list) = get(&runtime, "/workers", Caller::UNTRUSTED).await;
    let ids: Vec<&str> = list.as_array().expect("rows").iter().map(|w| w["id"].as_str().expect("id")).collect();
    assert_eq!(status, 200);
    assert_eq!(
        ids,
        ["w-BUSY", "w-BARE", "w-KID2", "w-KID1", "o-ORCH", "w-LONG", "w-CHAT"],
        "newest first, w-ARCH left out"
    );
    assert_eq!(list[0]["context"], serde_json::json!({ "used": 400, "limit": 1_000_000, "pct": 0 }));

    let (_, brief) = get(&runtime, "/workers?brief=1", Caller::UNTRUSTED).await;
    let row = &brief[5];
    assert_eq!(row["prompt"].as_str().map(str::len), Some(280));
    assert_eq!(row["prompt_clipped"], true);
    assert!(brief[0].get("prompt_clipped").is_none(), "a short prompt is left alone");
    let (_, full) = get(&runtime, "/workers/w-LONG", Caller::UNTRUSTED).await;
    assert_eq!(full["prompt"].as_str().map(str::len), Some(500), "one row always carries the whole prompt");

    let (_, archived) = get(&runtime, "/workers/archived", Caller::UNTRUSTED).await;
    assert_eq!(archived.as_array().map(Vec::len), Some(1));
    assert!(archived[0].get("context").is_none(), "the archive list adds nothing to the rows");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_goal_loop_on_record_leaves_its_workers_row_plain() {
    let temp = TempStore::seeded("/sandbox");
    temp.exec("UPDATE worker_loops SET status = 'active' WHERE id = 'l-SEED1'");
    let runtime = runtime(&temp);
    let (_, list) = get(&runtime, "/workers", Caller::UNTRUSTED).await;
    let rows = list.as_array().expect("rows");
    assert!(rows.iter().any(|w| w["id"] == "w-KID1"));
    assert!(rows.iter().all(|w| w.get("loop").is_none()), "{list}");
    let (_, one) = get(&runtime, "/workers/w-KID1", Caller::UNTRUSTED).await;
    assert!(one.get("loop").is_none(), "{one}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_reads_rows_and_transcripts_but_not_the_panel_lists() {
    let temp = TempStore::seeded("/sandbox");
    let runtime = runtime(&temp);
    let phone = Caller::Phone { grant: Tier::Read, mutate: false };
    for target in
        ["/workers", "/workers/archived", "/workers/w-CHAT", "/orchestrators", "/workers/w-CHAT/events?limit=3"]
    {
        assert_eq!(get(&runtime, target, phone.clone()).await.0, 200, "{target}");
    }
    for target in ["/workers/w-CHAT/prompt-events", "/workers/w-CHAT/subagent-events", "/workers/w-CHAT/attachments"] {
        assert_eq!(get(&runtime, target, phone.clone()).await.0, 403, "{target}");
        assert_eq!(get(&runtime, target, Caller::UNTRUSTED).await.0, 200, "{target}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transcript_row_is_shown_without_the_wrappers_the_model_saw() {
    let temp = TempStore::seeded("/sandbox");
    temp.exec(
        r#"INSERT INTO events (worker_id, ts, type, payload) VALUES ('w-BARE', 1790000340000, 'orchestrator_message',
           '{"text":"<agent_message from=\"JSON flag\" from-id=\"o-ORCH\">\nPlease report.\n</agent_message>"}')"#,
    );
    let runtime = runtime(&temp);
    let (_, rows) = get(&runtime, "/workers/w-BARE/events?order=asc", Caller::UNTRUSTED).await;
    let last = rows.as_array().and_then(|r| r.last()).expect("a row");
    assert_eq!(last["payload"], r#"{"text":"Please report."}"#);
    let (_, prompts) = get(&runtime, "/workers/w-BARE/prompt-events", Caller::UNTRUSTED).await;
    assert_eq!(prompts.as_array().and_then(|r| r.last()).map(|r| &r["payload"]), Some(&last["payload"]));

    let stored = temp.store.read_blocking(|tx| {
        tx.events().list_by_type("w-BARE", eos_contracts::WorkerEventType::OrchestratorMessage, None)
    });
    assert!(
        stored.expect("reads")[0].payload.as_deref().is_some_and(|p| p.contains("<agent_message")),
        "the stored row keeps them"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_queue_shows_the_users_waiting_messages_as_typed() {
    let temp = TempStore::seeded("/sandbox");
    temp.exec(
        r#"INSERT INTO queued_messages (worker_id, client_msg_id, text, created_at, dispatched_at, meta, plane) VALUES
           ('w-CHAT', 'c-1', 'expanded /review text', 100, NULL, '{"displayText":"/review"}', 'user'),
           ('w-CHAT', 'c-2', 'plain', 200, NULL, NULL, 'user'),
           ('w-CHAT', NULL, 'a worker reports', 300, NULL, NULL, 'agent'),
           ('w-CHAT', 'c-0', 'already delivered', 50, 60, NULL, 'user')"#,
    );
    let runtime = runtime(&temp);
    let (status, queue) = get(&runtime, "/workers/w-CHAT/queue", Caller::UNTRUSTED).await;
    assert_eq!(status, 200);
    assert_eq!(
        queue,
        serde_json::json!({ "messages": [{ "id": 1, "text": "/review", "ts": 100 }, { "id": 2, "text": "plain", "ts": 200 }] })
    );
    assert_eq!(
        get(&runtime, "/workers/w-nope/queue", Caller::UNTRUSTED).await.1,
        serde_json::json!({ "messages": [] })
    );
}

/// A worker the questions feature says waits on the user.
struct Asking(&'static str);

impl eos_core::agent::OpenQuestions for Asking {
    fn has_open(&self, worker_id: &str) -> bool {
        worker_id == self.0
    }

    fn open_askers(&self) -> Vec<String> {
        vec![self.0.to_owned()]
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rows_by_id_are_the_list_routes_rows_byte_for_byte() {
    let temp = TempStore::seeded("/sandbox");
    let long = "wörd 😀 ".repeat(60);
    temp.exec(&format!("UPDATE workers SET prompt = '{long}' WHERE id = 'w-LONG'"));
    let module =
        WorkersModule::new(temp.port(), Arc::new(FakeModelCatalog::default()), Arc::new(eos_testkit::FakeClock::new()))
            .with_open_questions(Arc::new(Asking("w-CHAT")));
    let (full, brief) = (module.listed_rows(false), module.listed_rows(true));
    let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![Arc::new(module)], Arc::new(AllPluginsOn))
        .expect("composes");

    for (target, source) in [("/workers", &full), ("/workers?brief=1", &brief)] {
        let res = runtime.router.handle(Request::new(Method::Get, target, Caller::UNTRUSTED)).await;
        let body = res.body.collect().await.expect("a body");
        let listed: Vec<&serde_json::value::RawValue> = serde_json::from_slice(&body).expect("rows");
        let listed: std::collections::HashMap<String, Vec<u8>> = listed
            .into_iter()
            .map(|row| {
                let id =
                    serde_json::from_str::<Value>(row.get()).expect("a row")["id"].as_str().expect("id").to_owned();
                (id, row.get().as_bytes().to_vec())
            })
            .collect();
        assert_eq!(listed.len(), 7, "{target}");
        let mut ids: Vec<String> = listed.keys().cloned().collect();
        ids.extend(["w-ARCH".to_owned(), "w-NONE".to_owned()]);
        let by_id = source.rows(&ids).await.expect("reads");
        assert_eq!(by_id, listed, "{target}: the same rows, the same bytes; archived and unknown ids have none");
    }
    let chat = full.rows(&["w-CHAT".to_owned()]).await.expect("reads");
    let chat: Value = serde_json::from_slice(&chat["w-CHAT"]).expect("a row");
    assert_eq!(chat["awaiting_question"], true, "{chat}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routines_sessions_and_their_children_stay_out_of_the_lists() {
    let temp = TempStore::seeded("/sandbox");
    // o-ORCH leads a run (w-KID1 and w-KID2 are its children); w-ARCH, archived, was an architect.
    temp.exec(
        "INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) VALUES \
         ('o-ORCH', 'rt-1', 'rn-1', 'lead', 1), ('w-ARCH', 'rt-1', NULL, 'architect', 1)",
    );
    let module =
        WorkersModule::new(temp.port(), Arc::new(FakeModelCatalog::default()), Arc::new(eos_testkit::FakeClock::new()));
    let rows = module.listed_rows(true);
    let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![Arc::new(module)], Arc::new(AllPluginsOn))
        .expect("composes");
    let ids = |list: &Value| -> Vec<String> {
        list.as_array().expect("rows").iter().map(|w| w["id"].as_str().expect("id").to_owned()).collect()
    };

    let (status, list) = get(&runtime, "/workers", Caller::UNTRUSTED).await;
    assert_eq!(status, 200);
    assert_eq!(ids(&list), ["w-BUSY", "w-BARE", "w-LONG", "w-CHAT"], "the run's lead and its children left out");
    let (_, archived) = get(&runtime, "/workers/archived", Caller::UNTRUSTED).await;
    assert_eq!(ids(&archived), Vec::<String>::new(), "the architect left out of the archive too");

    let wanted: Vec<String> = ["o-ORCH", "w-KID1", "w-KID2", "w-CHAT"].map(str::to_owned).to_vec();
    let found = rows.rows(&wanted).await.expect("reads");
    assert_eq!(found.keys().collect::<Vec<_>>(), ["w-CHAT"], "patches remove the routine's rows");

    for id in ["o-ORCH", "w-KID1", "w-ARCH"] {
        let (status, row) = get(&runtime, &format!("/workers/{id}"), Caller::UNTRUSTED).await;
        assert_eq!((status, row["id"].as_str()), (200, Some(id)), "one row is still served by id");
    }
}
