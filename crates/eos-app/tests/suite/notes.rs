//! Pages, the profile and memories in the composed app: requests in, files
//! of today's layout out, and the files read back by a second run.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, Options};
use eos_runtime::http::{Method, Request, Response};
use eos_testkit::{FakeClock, SeqIds, TempHome};
use serde_json::{Value, json};

fn options(home: &TempHome) -> Options {
    Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        env: Default::default(),
        ..Options::new(home.path())
    }
}

async fn json_of(res: Response) -> (u16, Value) {
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn pages_the_profile_and_memories_are_served_and_kept_as_files() {
    let home = TempHome::new();
    let app = App::build(options(&home)).expect("builds");
    app.start().await.expect("starts");
    let router = app.router();
    assert_eq!(router.undeclared(), Vec::<String>::new());
    let dashboard = app.callers().classify(Some(app.callers().ui_token()));
    let page_frame = app.callers().classify(None);
    let mut changes = app.runtime().kernel.bus.subscribe(eos_runtime::bus::Filter::All, 16);

    let create =
        Request::new(Method::Post, "/api/pages", page_frame.clone()).body(r##"{"title":"Plan","body":"# Plan\n"}"##);
    let (status, created) = json_of(router.handle(create).await).await;
    assert_eq!(status, 201);
    let id = created["page"]["id"].as_str().expect("an id").to_owned();
    let file = home.read(format!("pages/{id}.md"));
    assert_eq!(
        file,
        format!(
            "---\nid: {id}\ntitle: Plan\nproject: null\nagentId: null\nrev: 1\ncreatedAt: {now}\nupdatedAt: {now}\nupdatedBy:\n  kind: user\n  agentId: null\n  name: null\n---\n# Plan\n",
            now = FakeClock::START_MS
        )
    );
    let unsigned = router.handle(Request::new(Method::Delete, &format!("/api/pages/{id}"), page_frame.clone())).await;
    assert_eq!(unsigned.status, 403, "deleting a page is the user's");

    let save = Request::new(Method::Put, "/api/profile", dashboard.clone())
        .body(r#"{"patch":{"identity":{"callName":"Sam"}},"baseRev":0}"#);
    let (status, saved) = json_of(router.handle(save).await).await;
    assert_eq!((status, &saved["profile"]["rev"]), (200, &json!(1)));
    assert!(home.read("profile/profile.json").starts_with("{\n  \"rev\": 1,\n  \"updatedAt\": "));

    let remember = Request::new(Method::Post, "/api/user-memories", dashboard.clone())
        .body(r#"{"text":"When writing Go, use tabs.","category":"work-style","scope":{"kind":"global"}}"#);
    let (status, remembered) = json_of(router.handle(remember).await).await;
    assert_eq!(status, 201);
    let memory = remembered["memory"]["id"].as_str().expect("an id").to_owned();
    assert!(home.read(format!("profile/memories/{memory}.md")).ends_with("---\nWhen writing Go, use tabs.\n"));

    let topics: Vec<String> = {
        app.runtime().kernel.bus.flush().await;
        let mut seen = Vec::new();
        while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(20), changes.recv()).await {
            seen.push(event.topic.to_string());
        }
        seen
    };
    assert_eq!(topics, ["pages:change", "profile:change", "user-memory:change"]);
    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
    drop(app);

    // A second run reads what the first one wrote.
    let app = App::build(options(&home)).expect("builds again");
    let router = app.router();
    let (_, pages) =
        json_of(router.handle(Request::new(Method::Get, "/api/pages?all=1", page_frame.clone())).await).await;
    assert_eq!(pages["pages"][0]["id"], json!(id));
    let (_, profile) =
        json_of(router.handle(Request::new(Method::Get, "/api/profile", page_frame.clone())).await).await;
    assert_eq!(profile["profile"]["identity"]["callName"], "Sam");
    let (_, memories) = json_of(router.handle(Request::new(Method::Get, "/api/user-memories", page_frame)).await).await;
    assert_eq!(memories["memories"][0]["id"], json!(memory));
    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
}
