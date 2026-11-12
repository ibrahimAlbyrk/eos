//! Large answers leave in slices — transcript pages of thousands of rows, the
//! conversation-wide subagent list, a long export — with the very bytes the
//! whole list serialized at once gives, and short ones still at once.

use std::sync::Arc;

use eos_core::store::{EventOrder, EventQuery};
use eos_domain::display::sanitize_event;
use eos_domain::transcript::select_subagent_rows;
use eos_mod_workers::WorkersModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Body, Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeModelCatalog, TempStore};
use serde_json::{Value, json};

fn runtime(temp: &TempStore) -> Runtime {
    let module = Arc::new(WorkersModule::new(
        temp.port(),
        Arc::new(FakeModelCatalog::default()),
        Arc::new(eos_testkit::FakeClock::new()),
    ));
    Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes")
}

/// 2,500 rows for `w-BIG`: messages with unicode and `<`, tool calls, a
/// subagent run every 50 rows with its inner tools, same-millisecond ties.
fn seed(temp: &TempStore) {
    temp.exec("INSERT INTO workers (id, state, prompt, started_at, tool_calls, scratch) VALUES ('w-BIG', 'IDLE', 'go', 1, 0, 0)");
    let mut sql = String::from("BEGIN;");
    for n in 0..2_500 {
        let payload = match n % 50 {
            0 => {
                json!({"type": "message", "role": "assistant", "blocks": [{"type": "tool_call", "callId": format!("t{n}"), "name": "Agent", "input": {}}]})
            }
            1 => json!({"type": "subagent_started", "callId": format!("t{}", n - 1), "agentId": format!("a{n}")}),
            2..=30 => {
                json!({"type": "activity", "kind": "tool_started", "callId": format!("c{n}"), "toolName": "Read", "parentCallId": format!("t{}", n - n % 50)})
            }
            31 => {
                json!({"type": "subagent_completed", "callId": format!("t{}", n - 31), "status": "completed", "result": "çok iyi </script> ✓"})
            }
            _ if n % 7 == 0 => json!({"type": "turn", "phase": "ended"}),
            _ => {
                json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": format!("satır {n}: ğüşıöç <b>ok</b> 😀")}]})
            }
        };
        let payload = payload.to_string().replace('\'', "''");
        sql.push_str(&format!(
            "INSERT INTO events (worker_id, ts, type, payload) VALUES ('w-BIG', {}, 'agent_event', '{payload}');",
            1_000 + n / 3
        ));
    }
    sql.push_str("COMMIT;");
    temp.exec(&sql);
}

/// The body, and whether it came in slices.
async fn get(runtime: &Runtime, target: &str) -> (u16, Vec<u8>, bool) {
    let res = runtime.router.handle(Request::new(Method::Get, target, Caller::DASHBOARD)).await;
    let streamed = matches!(res.body, Body::Stream(_));
    let status = res.status;
    (status, res.body.collect().await.expect("a body").to_vec(), streamed)
}

async fn rows(temp: &TempStore, query: EventQuery) -> Vec<eos_domain::EventRecord> {
    temp.port().read(move |tx| tx.events().list(&query)).await.expect("reads")
}

fn whole(rows: Vec<eos_domain::EventRecord>) -> Vec<u8> {
    let wire: Vec<_> = rows.into_iter().map(|row| sanitize_event(row).into_row()).collect();
    serde_json::to_vec(&wire).expect("serializes")
}

fn query(order: EventOrder, limit: i64) -> EventQuery {
    EventQuery { worker_id: "w-BIG".into(), since: 0, limit, order, before_id: None, after_id: None }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_of_thousands_of_rows_streams_the_same_bytes() {
    let temp = TempStore::seeded("/sandbox");
    seed(&temp);
    let runtime = runtime(&temp);
    for (target, order) in [
        ("/workers/w-BIG/events?limit=5000", EventOrder::Desc),
        ("/workers/w-BIG/events?limit=2000", EventOrder::Desc),
        ("/workers/w-BIG/events?limit=5000&order=asc", EventOrder::Asc),
    ] {
        let limit: i64 = target
            .split("limit=")
            .nth(1)
            .and_then(|l| l.split('&').next())
            .and_then(|l| l.parse().ok())
            .expect("a limit");
        let (status, body, streamed) = get(&runtime, target).await;
        assert_eq!(status, 200);
        assert!(streamed, "{target} leaves in slices");
        assert_eq!(body, whole(rows(&temp, query(order, limit)).await), "{target}");
    }
    let (_, body, streamed) = get(&runtime, "/workers/w-BIG/events?limit=500").await;
    assert!(!streamed, "a usual page is sent at once");
    assert_eq!(body, whole(rows(&temp, query(EventOrder::Desc, 500)).await));
    // A page asked large that holds few rows is sent at once.
    let (_, body, streamed) = get(&runtime, "/workers/w-CHAT/events?limit=5000").await;
    assert!(!streamed);
    let few = EventQuery { worker_id: "w-CHAT".into(), ..query(EventOrder::Desc, 5000) };
    assert_eq!(body, whole(rows(&temp, few).await));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_subagent_list_is_judged_a_slice_at_a_time_and_streams_the_same_bytes() {
    let temp = TempStore::seeded("/sandbox");
    seed(&temp);
    let runtime = runtime(&temp);
    let all = rows(&temp, query(EventOrder::Asc, -1)).await;
    let expected = whole(select_subagent_rows(all));
    let (status, body, streamed) = get(&runtime, "/workers/w-BIG/subagent-events").await;
    assert_eq!(status, 200);
    assert!(streamed, "over a thousand rows leave in slices");
    assert_eq!(body, expected);
    // The seeded chats' short lists, at once.
    for chat in ["w-CHAT", "o-ORCH", "w-KID1"] {
        let all = rows(&temp, EventQuery { worker_id: chat.into(), ..query(EventOrder::Asc, -1) }).await;
        let (_, body, streamed) = get(&runtime, &format!("/workers/{chat}/subagent-events")).await;
        assert!(!streamed);
        assert_eq!(body, whole(select_subagent_rows(all)), "{chat}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_export_streams_the_same_page() {
    let temp = TempStore::seeded("/sandbox");
    seed(&temp);
    let runtime = runtime(&temp);
    let (status, body, streamed) = get(&runtime, "/workers/w-BIG/export").await;
    assert_eq!(status, 200);
    assert!(streamed);
    let page = String::from_utf8(body).expect("text");
    let template = include_str!("../assets/export.html");
    let placeholder = r#"<script id="export-data" type="application/json">{}</script>"#;
    let at = template.find(placeholder).expect("the placeholder");
    let open = r#"<script id="export-data" type="application/json">"#;
    assert!(page.starts_with(&format!("{}{open}", &template[..at])));
    assert!(page.ends_with(&format!("</script>{}", &template[at + placeholder.len()..])));
    let json = &page[at + open.len()..page.len() - (template.len() - at - placeholder.len()) - "</script>".len()];
    assert!(!json.contains('<'), "nothing in the data can close the script element");
    let data: Value = serde_json::from_str(json).expect("the data block");
    let all = rows(&temp, query(EventOrder::Asc, -1)).await;
    let events = data["events"].as_array().expect("events");
    assert_eq!(events.len(), all.len());
    assert_eq!(events[31]["payload"]["result"], "çok iyi </script> ✓");
    // Re-serialized whole, the block is the page's own bytes.
    let again = data.to_string().replace('<', "\\u003c");
    assert_eq!(json, again);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_named_beyond_latin1_downloads_under_its_own_name() {
    let temp = TempStore::seeded("/sandbox");
    seed(&temp);
    temp.exec("UPDATE workers SET name = 'şişe 日本 🍾' WHERE id IN ('w-CHAT', 'w-BIG')");
    let runtime = runtime(&temp);
    // At once and in slices: the same header.
    for chat in ["w-CHAT", "w-BIG"] {
        let res = runtime
            .router
            .handle(Request::new(Method::Get, &format!("/workers/{chat}/export"), Caller::DASHBOARD))
            .await;
        assert_eq!(res.status, 200, "{chat}");
        let disposition = res
            .headers
            .iter()
            .find(|(name, _)| name == "content-disposition")
            .map(|(_, v)| v.to_string())
            .expect("named");
        assert!(disposition.is_ascii(), "a header value carries bytes, not text: {disposition}");
        let real = "export-%C5%9Fi%C5%9Fe%20%E6%97%A5%E6%9C%AC%20%F0%9F%8D%BE-";
        assert!(disposition.starts_with(&format!("attachment; filename*=UTF-8''{real}")), "{disposition}");
        assert!(disposition.contains("; filename=\"export-_i_e __ _-"), "the ASCII stand-in: {disposition}");
    }
}
