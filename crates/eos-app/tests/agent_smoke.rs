//! One focused chat turn through the whole app against the engine's scripted
//! model API: route → session → engine → model → events → rows → stream.
//!
//! Ignored: it starts a real engine (shell snapshot, tool set, an HTTP
//! server for the scripted model). No real model is called and no real
//! credential is read. Run it with
//! `cargo test -p eos-app --test agent_smoke -- --ignored`.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{AgentOptions, App, Options};
use eos_core::accounts::SessionCredential;
use eos_engine::mock_api::{MockApi, Reply};
use eos_runtime::http::{Body, Method, Request};
use eos_testkit::{FakeClock, SeqIds, TempHome};
use serde_json::{Value, json};

fn fs_read(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

async fn call(app: &App, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
    let caller = app.callers().classify(Some(app.callers().ui_token()));
    let mut request = Request::new(method, target, caller);
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body.to_string());
    }
    let res = app.router().handle(request).await;
    let status = res.status;
    let bytes = res.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "starts a real engine against a scripted model API"]
async fn a_focused_chat_turn_runs_from_the_route_to_the_stream() {
    // The second turn calls one of Eos's own tools, then answers.
    let page = r#"{"title":"Smoke notes","body":"- [ ] check the tools"}"#;
    let mock = MockApi::start([
        Reply::text("hello from the scripted model"),
        Reply::tool_use("toolu_page", "mcp__worker__create_page", page),
        Reply::text("the page is made"),
    ])
    .await
    .expect("the scripted model API");
    let home = TempHome::new();
    let project = tempfile::tempdir().expect("a folder");
    let claude_home = tempfile::tempdir().expect("a folder");
    let options = Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        env: Default::default(),
        agents: AgentOptions {
            base_url: Some(mock.base_url()),
            claude_home: Some(claude_home.path().to_owned()),
            no_mcp: true,
            default_model: Some("mock-model".into()),
            credential: Some(SessionCredential::ApiKey { provider: "anthropic".into(), key: "k-smoke".into() }),
            ..AgentOptions::default()
        },
        ..Options::new(home.path())
    };
    let app = App::build(options).expect("builds");
    app.start().await.expect("starts");

    // The dashboard's stream, opened before anything happens.
    let caller = app.callers().classify(Some(app.callers().ui_token()));
    let opened = app.router().handle(Request::new(Method::Get, "/stream", caller)).await;
    let Body::Stream(mut stream) = opened.body else { panic!("a stream") };

    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let (status, created) =
        call(&app, Method::Post, "/orchestrators", Some(json!({"mode": "focused", "cwd": cwd, "prompt": "say hello"})))
            .await;
    assert_eq!(status, 201, "{created}");
    let id = created["id"].as_str().expect("an id").to_owned();

    // The stream carries the turn: live text, then the worker going idle.
    let mut frames = String::new();
    let idle = format!("\"workerId\":\"{id}\"");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while !(frames.contains("\"state\":\"IDLE\"") && frames.contains(&idle)) {
        let chunk = tokio::time::timeout_at(deadline, stream.next()).await.expect("the turn ends in time");
        frames.push_str(&String::from_utf8_lossy(&chunk.expect("the stream stays open").expect("a frame")));
    }
    assert!(frames.contains("event: agent:delta") || frames.contains("agent:delta"), "live text reached the stream");
    assert!(frames.contains("hello from the scripted model"), "{frames}");
    assert!(frames.contains("worker:spawn") && frames.contains("usage:recorded"), "{frames}");

    // The rows the dashboard and the phone render.
    let (_, rows) = call(&app, Method::Get, &format!("/workers/{id}/events?order=asc&limit=200"), None).await;
    let kinds: Vec<String> = rows
        .as_array()
        .expect("rows")
        .iter()
        .map(|r| {
            let payload: Value = serde_json::from_str(r["payload"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
            match (r["type"].as_str().unwrap_or_default(), payload["type"].as_str(), payload["phase"].as_str()) {
                ("state", _, _) => format!("state:{}", payload["state"].as_str().unwrap_or_default()),
                ("agent_event", Some(kind), Some(phase)) => format!("{kind}:{phase}"),
                ("agent_event", Some(kind), None) => kind.to_owned(),
                ("agent_event", None, _) => "usage".to_owned(),
                (other, _, _) => other.to_owned(),
            }
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "spawn",
            "user_message",
            "session:started",
            "session:ready",
            "turn:started",
            "state:WORKING",
            "message",
            "usage",
            "turn:ended",
            "state:IDLE"
        ]
    );
    let (_, row) = call(&app, Method::Get, &format!("/workers/{id}"), None).await;
    assert_eq!((row["state"].as_str(), row["agent_role"].as_str()), (Some("IDLE"), Some("focused")));
    assert_eq!(row["session_id"], id.as_str());

    // What the model was sent: the engine's own prompt with Eos's after it, on the session's credential.
    let request = &mock.requests()[0];
    assert_eq!(request.headers.get("x-api-key").and_then(|v| v.to_str().ok()), Some("k-smoke"));
    let sent = request.json();
    assert!(sent["messages"].to_string().contains("say hello"));
    assert!(sent["tools"].as_array().is_some_and(|tools| tools.iter().any(|t| t["name"] == "AskUserQuestion")));

    // Eos's own tools reach the model under the names the prompts use. A
    // focused chat runs with tool search: they are named, and found by search,
    // instead of being sent with every request.
    let offered: Vec<&str> =
        sent["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(offered.contains(&"ToolSearch") && !offered.contains(&"mcp__worker__create_page"), "{offered:?}");
    // The one tool whose description is its manual is sent in full.
    assert!(offered.contains(&"mcp__worker__present"), "{offered:?}");
    assert!(sent["messages"].to_string().contains("mcp__worker__create_page"), "the tool is named to the model");

    // A second turn through the message route: the model calls a page tool.
    let (status, sent) =
        call(&app, Method::Post, &format!("/workers/{id}/message"), Some(json!({"text": "make a page"}))).await;
    assert_eq!((status, sent), (200, json!({"ok": true})));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut more = String::new();
    while !more.contains("the page is made") {
        let chunk = tokio::time::timeout_at(deadline, stream.next()).await.expect("the second turn answers in time");
        more.push_str(&String::from_utf8_lossy(&chunk.expect("the stream stays open").expect("a frame")));
    }
    assert!(more.contains("pages:change"), "the page's change reached the stream: {more}");

    // The page is on disk, in the chat's project and linked to the chat.
    let (_, listed) = call(&app, Method::Get, "/api/pages?all=1", None).await;
    let made = &listed["pages"][0];
    assert_eq!((made["title"].as_str(), made["agentId"].as_str()), (Some("Smoke notes"), Some(id.as_str())));
    let page_id = made["id"].as_str().expect("a page id");
    let file = fs_read(&home.path().join(format!("pages/{page_id}.md")));
    assert!(file.contains("Smoke notes") && file.contains("- [ ] check the tools"), "{file}");

    // The tool's result is the row the chat shows and the model read.
    let (_, rows) = call(&app, Method::Get, &format!("/workers/{id}/events?order=asc&limit=200"), None).await;
    let result = rows
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|r| serde_json::from_str::<Value>(r["payload"].as_str().unwrap_or("null")).ok())
        .flat_map(|payload| payload["blocks"].as_array().cloned().unwrap_or_default())
        .find(|block| block["type"] == "tool_result" && block["callId"] == "toolu_page")
        .expect("the tool's result row");
    let expected = format!("{{\n  \"id\": \"{page_id}\",\n  \"title\": \"Smoke notes\",\n  \"rev\": 1\n}}");
    assert!(result.to_string().contains(&json!(expected).to_string()), "{result}");
    assert_ne!(result["isError"], true);
    let fed_back = mock.requests().last().expect("the request after the tool ran").json();
    assert!(fed_back["messages"].to_string().contains("Smoke notes"), "the model read the result");

    let (status, removed) = call(&app, Method::Delete, &format!("/workers/{id}"), None).await;
    assert_eq!((status, removed["removed"].as_bool()), (200, Some(true)));
    assert!(
        !home.path().join(format!("engine/transcripts/{id}.jsonl")).exists(),
        "its recorded conversation is deleted"
    );
    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
}
