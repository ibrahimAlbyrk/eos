//! Who may call the transfer routes, and how a refusal reads. The answers of
//! the endpoint routes themselves are held to the recorded wire by
//! `scripts/replay.sh --only 38-transfer` against the composed app.

#![allow(clippy::unwrap_used)]

mod support;

use std::fs;

use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_testkit::fixtures;
use serde_json::{Value, json};
use support::{Computer, TestClock, alone, s};

async fn call(
    c: &Computer,
    method: Method,
    target: &str,
    caller: Caller,
    body: Option<Value>,
    agent: Option<&str>,
) -> (u16, Value) {
    let mut request = Request::new(method, target, caller);
    if let Some(agent) = agent {
        request = request.header("x-eos-agent-id", agent);
    }
    if let Some(body) = body {
        request = request.body(body.to_string());
    }
    let response = c.router().handle(request).await;
    let body = serde_json::from_slice(&response.body.collect().await.unwrap()).unwrap_or(Value::Null);
    (response.status, body)
}

fn paired(human: bool) -> Caller {
    Caller::Peer { device: "f".repeat(64).into(), human }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_endpoint_is_the_users_here_or_on_a_paired_computer_and_the_engine_stays_here() {
    let tmp = tempfile::tempdir().unwrap();
    let c = Computer::new(&tmp.path().join("home"), &alone(), TestClock::real()).await;
    fs::write(c.home.join("a.txt"), "12345").unwrap();
    let list = format!("/transfer/list?path={}", s(&c.home));
    let forbidden = json!({ "error": "ui token required", "code": "forbidden" });

    assert_eq!(call(&c, Method::Get, &list, Caller::DASHBOARD, None, None).await.0, 200);
    assert_eq!(call(&c, Method::Get, &list, Caller::UNTRUSTED, None, None).await, (403, forbidden.clone()));
    // A paired computer's dashboard may use this disk; a process there that is not it may not.
    assert_eq!(call(&c, Method::Get, &list, paired(true), None, None).await.0, 200);
    assert_eq!(call(&c, Method::Get, &list, paired(false), None, None).await.0, 403);
    // With no path, the listing starts at home.
    let (_, home) = call(&c, Method::Get, "/transfer/list", Caller::DASHBOARD, None, None).await;
    assert_eq!(home["path"], s(&c.home));

    for (method, path) in [
        (Method::Get, "/api/transfers"),
        (Method::Post, "/api/transfers"),
        (Method::Delete, "/api/transfers"),
        (Method::Post, "/api/transfers/destination"),
        (Method::Post, "/api/transfers/tr-abcdef123456/pause"),
        (Method::Post, "/api/transfers/tr-abcdef123456/decide"),
    ] {
        assert_eq!(call(&c, method, path, Caller::UNTRUSTED, None, None).await, (403, forbidden.clone()), "{path}");
        assert_eq!(call(&c, method, path, paired(true), None, None).await.0, 403, "{path} stays on this computer");
    }
    assert_eq!(call(&c, Method::Post, "/workers/w-CHAT/transfers", paired(true), None, Some("w-CHAT")).await.0, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_engine_and_agent_routes_answer_as_recorded() {
    let tmp = tempfile::tempdir().unwrap();
    let c = Computer::new(&tmp.path().join("home"), &alone(), TestClock::real()).await;
    let sandbox = s(&c.home);
    let recorded = [
        ("16-services", "transfers"),
        ("16-services", "transfers-without-token"),
        ("16-services", "transfers-clear"),
        ("16-services", "transfer-start-invalid"),
        ("16-services", "transfer-destination-invalid"),
        ("16-services", "transfer-pause-unknown"),
        ("38-transfer", "destination"),
        ("38-transfer", "start-same-machine"),
        ("38-transfer", "agent-send-not-focused"),
        ("38-transfer", "agent-send-without-agent-header"),
        ("38-transfer", "agent-poll-without-agent-header"),
    ];
    for (scenario, name) in recorded {
        let recording = fixtures::recording(scenario);
        let exchange =
            recording["exchanges"].as_array().unwrap().iter().find(|e| e["step"]["name"] == name).unwrap().clone();
        let step = &exchange["step"];
        let (method, path) = step["request"].as_str().and_then(|r| r.split_once(' ')).unwrap();
        let caller = if step["auth"] == "none" { Caller::UNTRUSTED } else { Caller::DASHBOARD };
        let body = step
            .get("body")
            .map(|body| serde_json::from_str(&body.to_string().replace("{sandbox}", &sandbox)).unwrap());
        // The recorded agent calls carry the id in the path as their header, except where the step says not.
        let agent = (name == "agent-send-not-focused").then_some("w-KID1");
        let (status, answer) = call(&c, Method::parse(method).unwrap(), path, caller, body, agent).await;
        assert_eq!(Value::from(status), exchange["response"]["status"], "{name}");
        // A body with several wrong fields names the first one here, all of them in Zod.
        if !name.ends_with("-invalid") {
            assert_eq!(answer, exchange["response"]["json"], "{name}");
        }
    }

    // A focused agent that names a computer nobody paired hears so, as a 400.
    let ask = json!({ "machine": "desk", "paths": ["README.md"] });
    let (status, answer) =
        call(&c, Method::Post, "/workers/w-CHAT/transfers", Caller::UNTRUSTED, Some(ask), Some("w-CHAT")).await;
    assert_eq!(status, 400);
    assert_eq!(answer, json!({ "error": "No paired Mac matches \"desk\". This Mac isn't paired with any other Mac." }));
    // Its poll of a transfer that is not there is a 404.
    let poll = "/workers/w-CHAT/transfers/tr-abcdef123456";
    let (status, answer) = call(&c, Method::Get, poll, Caller::UNTRUSTED, None, Some("w-CHAT")).await;
    assert_eq!((status, answer), (404, json!({ "error": "transfer not found: tr-abcdef123456" })));
    // An agent asking in another agent's name is refused.
    let (status, _) = call(&c, Method::Get, poll, Caller::UNTRUSTED, None, Some("w-LONG")).await;
    assert_eq!(status, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_carries_its_code_and_what_is_held() {
    let tmp = tempfile::tempdir().unwrap();
    let c = Computer::new(&tmp.path().join("home"), &alone(), TestClock::real()).await;
    fs::write(c.home.join("f.txt"), "abcdef").unwrap();
    let dest = s(&c.home.join("in"));
    let (_, manifest) = call(
        &c,
        Method::Post,
        "/transfer/scan",
        Caller::DASHBOARD,
        Some(json!({ "paths": [s(&c.home.join("f.txt"))] })),
        None,
    )
    .await;
    let prepare = json!({ "id": "tr-wire0001", "destDir": dest, "items": manifest["items"] });
    assert_eq!(call(&c, Method::Post, "/transfer/prepare", Caller::DASHBOARD, Some(prepare), None).await.0, 200);
    let write = |offset: u64| format!("/transfer/write?id=tr-wire0001&dest={dest}&rel=f.txt&offset={offset}");
    let put = |target: String, bytes: &'static [u8]| {
        let request = Request::new(Method::Put, &target, Caller::DASHBOARD).body(bytes);
        let router = c.router();
        async move {
            let response = router.handle(request).await;
            let body: Value = serde_json::from_slice(&response.body.collect().await.unwrap()).unwrap();
            (response.status, body)
        }
    };
    assert_eq!(put(write(0), b"abc").await, (200, json!({ "size": 3 })));
    let mismatch = json!({ "error": "f.txt holds 3 bytes, not 0", "code": "offset-mismatch", "have": 3 });
    assert_eq!(put(write(0), b"abc").await, (409, mismatch));
    assert_eq!(put(write(3), b"def").await, (200, json!({ "size": 6 })));
    let read = format!(
        "/transfer/read?path={}&offset=2&length=3&size=6&mtime={}",
        s(&c.home.join("f.txt")),
        manifest["items"][0]["mtimeMs"]
    );
    let response = c.router().handle(Request::new(Method::Get, &read, Caller::DASHBOARD)).await;
    assert_eq!(response.header_value("content-type"), Some("application/octet-stream"));
    assert_eq!(&response.body.collect().await.unwrap()[..], b"cde");
    let outside = read.replace("offset=2", "offset=x");
    let (status, answer) = call(&c, Method::Get, &outside, Caller::DASHBOARD, None, None).await;
    assert_eq!((status, answer["code"].as_str()), (400, Some("bad-path")));
    let commit = json!({ "id": "tr-wire0001", "destDir": dest, "decisions": {} });
    let (status, placed) = call(&c, Method::Post, "/transfer/commit", Caller::DASHBOARD, Some(commit), None).await;
    assert_eq!((status, &placed["placed"][0]["name"]), (200, &json!("f.txt")));
    assert_eq!(fs::read_to_string(c.home.join("in/f.txt")).unwrap(), "abcdef");
}
