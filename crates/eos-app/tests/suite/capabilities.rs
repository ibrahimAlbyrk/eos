//! Capability secrets never reach what a model or the dashboard reads: a capability's answer
//! that quotes its secret reaches the chat's model, and its rows, with `[secret]` in its
//! place, and neither that secret nor GitHub's token, codes or account name is in a row or
//! a frame of the stream (every topic).

use std::time::Duration;

use eos_runtime::http::Method;
use eos_testkit::agent::{Turn, events};
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use crate::planted::{ECHO_SECRET, Planted, call_capability, sign_in_to_github};
use crate::rig;

/// Every frame until one matches, kept in `seen`.
async fn read_until(frames: &mut rig::Frames, seen: &mut Vec<Value>, matches: impl Fn(&Value) -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while let Some(frame) = frames.next(deadline.saturating_duration_since(tokio::time::Instant::now())).await {
        let done = matches(&frame);
        seen.push(frame);
        if done {
            return;
        }
    }
    panic!("no frame matched");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capability_secrets_never_reach_a_tool_result_or_the_stream() {
    let home = TempHome::new();
    let agents = ScriptedRuntime::new();
    agents.otherwise(rig::turn_for);
    let planted = Planted::plant();
    let app = rig::build_with(home.path(), &agents, planted.options());
    app.start().await.expect("starts");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
    let mut seen = Vec::new();

    let project = tempfile::tempdir().expect("a project");
    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let chat = rig::focused_chat(&app, &cwd, "Read the echo note.").await;
    read_until(&mut frames, &mut seen, |f| rig::went(f, &chat, "IDLE")).await;

    let input = json!({ "capability": "echo", "action": "read_note", "input": {} });
    let reply = call_capability(&app, &agents, &chat, input.clone()).await;
    assert!(!reply.is_error, "{}", reply.text);
    assert!(reply.text.contains("The key is [secret].") && !reply.text.contains(ECHO_SECRET), "{}", reply.text);

    // The model's turn carries that result into the chat, as the engine does.
    let call = serde_json::from_value(input).unwrap_or_default();
    agents.script(Turn::of(vec![
        events::tool_call("toolu_capability", "call_capability", call),
        events::tool_result("toolu_capability", &reply.text, false),
        events::text("The note is read.", "m-capability:1"),
    ]));
    let body = json!({ "text": "Read it again.", "clientMsgId": "c-capability", "queueWhenBusy": true });
    let (status, answer) = rig::call(&app, Method::Post, &format!("/workers/{chat}/message"), Some(body)).await;
    assert!(status < 300, "{answer}");
    read_until(&mut frames, &mut seen, |f| rig::went(f, &chat, "IDLE")).await;

    let signed_in = sign_in_to_github(&app).await;
    assert_eq!(signed_in["state"], "signed_in");
    let ready = |f: &Value| f["reason"] == "capabilities:change" && f["payload"]["id"] == "github";
    read_until(&mut frames, &mut seen, |f| ready(f) && f["payload"]["state"] == "ready").await;

    // The chat's rows, which the dashboard and the phone render, hold the result as the model read it.
    let (_, rows) = rig::call(&app, Method::Get, &format!("/workers/{chat}/events?order=asc&limit=200"), None).await;
    let rows = rows.to_string();
    assert!(rows.contains("The key is [secret]."), "the result is in the chat");
    let streamed = serde_json::to_string(&seen).expect("frames");
    for value in planted.values() {
        assert!(!streamed.contains(&value), "{value} reached the stream");
        assert!(!rows.contains(&value), "{value} reached the chat");
    }
    app.shutdown(Duration::from_secs(5)).await;
}
