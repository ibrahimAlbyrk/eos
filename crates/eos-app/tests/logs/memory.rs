//! Memory: a chat where the user states a planted rule and corrects the agent with planted
//! words, so About you keeps one and a note is learned from the other; the note edited with
//! planted text, said "Not right" with a planted reason, and recalled by a planted query.
//! The log tells capture, reflection and the stated rule by count; no note text, cue,
//! hook key or query reaches it.

use std::time::Duration;

use eos_app::App;
use eos_core::agent::ToolCaller;
use eos_runtime::http::Method;
use eos_testkit::ScriptedRuntime;
use serde_json::{Value, json};

use crate::{Area, rig};

const RULE: &str = "PLANTED-memory-rule-kestrel";
const FIX: &str = "PLANTED-memory-fix-plover";
const EDIT: &str = "PLANTED-memory-edit-tern";
const REASON: &str = "PLANTED-memory-reason-avocet";
const QUERY: &str = "PLANTED-memory-query-dunlin";

async fn notes(app: &App) -> Vec<Value> {
    let (status, list) = rig::call(app, Method::Get, "/api/memory/notes", None).await;
    assert_eq!(status, 200, "{list}");
    list["notes"].as_array().cloned().unwrap_or_default()
}

pub(crate) async fn steps(app: &App, agents: &ScriptedRuntime) -> Area {
    let project = tempfile::tempdir().expect("a project");
    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let mut frames = rig::Frames::new(rig::open_stream(app, "topics=worker:*").await.expect("a stream"));
    let chat = rig::focused_chat(app, &cwd, &format!("From now on always run {RULE} before pushing.")).await;
    let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;
    let body = json!({"text": format!("No, that is wrong: use {FIX} instead."), "clientMsgId": "c-memory",
                      "queueWhenBusy": true});
    let (status, answer) = rig::call(app, Method::Post, &format!("/workers/{chat}/message"), Some(body)).await;
    assert!(status < 300, "{answer}");
    let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;

    let mut learned = Vec::new();
    for _ in 0..400 {
        learned = notes(app).await;
        if learned.iter().any(|n| n["text"].as_str().is_some_and(|t| t.contains(FIX))) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let note = learned.iter().find(|n| n["text"].as_str().is_some_and(|t| t.contains(FIX))).expect("a note");
    let id = note["id"].as_str().expect("an id").to_owned();
    let edit = json!({"text": format!("Use {EDIT} before pushing."), "baseRev": note["rev"]});
    let (status, edited) = rig::call(app, Method::Put, &format!("/api/memory/notes/{id}"), Some(edit)).await;
    assert_eq!(status, 200, "{edited}");
    let said = json!({"workerId": chat, "note": REASON});
    let (status, hurt) = rig::call(app, Method::Post, &format!("/api/memory/notes/{id}/not-right"), Some(said)).await;
    assert_eq!(status, 200, "{hurt}");

    let spec = agents.started().into_iter().find(|s| s.worker_id == chat).expect("the chat's session");
    let tools = app.tools().for_session(&spec);
    let recall = tools.iter().find(|t| t.definition().name == "recall_experience").expect("the tool");
    let caller = ToolCaller { worker_id: &chat, call_id: "toolu_recall", subagent_id: None };
    let reply = recall.call(caller, json!({"query": format!("pushing with {EDIT} {QUERY}")})).await;
    assert!(!reply.is_error, "{}", reply.text);
    let (status, _) = rig::call(app, Method::Delete, &format!("/workers/{chat}"), None).await;
    assert!(status < 300);

    let told = ["memory: captured", "memory: kept a stated rule", "memory: reflected"];
    Area {
        planted: [RULE, FIX, EDIT, REASON, QUERY].map(str::to_owned).to_vec(),
        told: told.map(str::to_owned).to_vec(),
    }
}
