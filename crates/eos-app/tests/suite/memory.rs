//! Memory in the composed app: a rule the user states in a chat is kept in About you at once;
//! a correction becomes a note the Memory screen lists, with what taught it; with Learning
//! switched off in Settings › Eos a new correction makes no note, and with Reminders off the
//! next chat gets no pack.

use std::time::Duration;

use eos_app::App;
use eos_runtime::http::Method;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use crate::rig;
use crate::routines_rig::eventually;

async fn notes(app: &App) -> Vec<Value> {
    let (status, list) = rig::call(app, Method::Get, "/api/memory/notes", None).await;
    assert_eq!(status, 200, "{list}");
    list["notes"].as_array().cloned().unwrap_or_default()
}

/// Says `text` in `chat` and waits for its turn to end.
async fn say(app: &App, frames: &mut rig::Frames, chat: &str, text: &str) {
    let body = json!({"text": text, "clientMsgId": format!("c-{}", text.len()), "queueWhenBusy": true});
    let (status, answer) = rig::call(app, Method::Post, &format!("/workers/{chat}/message"), Some(body)).await;
    assert!(status < 300, "{answer}");
    frames.until(Duration::from_secs(20), |f| rig::went(f, chat, "IDLE")).await.expect("the turn ends");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stated_rule_is_kept_at_once_a_correction_is_learned_and_the_switches_stop_both() {
    let home = TempHome::new();
    let agents = ScriptedRuntime::new();
    agents.otherwise(rig::turn_for);
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let project = tempfile::tempdir().expect("a project");
    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let mut frames = rig::Frames::new(rig::open_stream(&app, "topics=worker:*").await.expect("a stream"));

    // "From now on" in a chat: About you keeps it, no model asked.
    let chat = rig::focused_chat(&app, &cwd, "From now on use pnpm here, not npm.").await;
    frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await.expect("the turn ends");
    let kept = || async {
        let (status, list) = rig::call(&app, Method::Get, "/api/user-memories", None).await;
        assert_eq!(status, 200, "{list}");
        list.to_string().contains("use pnpm here")
    };
    eventually("About you keeps the rule", kept).await;

    // A correction after the agent spoke: a note the Memory screen lists, taught by what the user said.
    say(&app, &mut frames, &chat, "No, that is wrong: run the linter before the tests.").await;
    eventually("a note is learned", || async { !notes(&app).await.is_empty() }).await;
    let learned = notes(&app).await;
    assert_eq!(learned.len(), 1, "{learned:?}");
    assert_eq!((learned[0]["trust"].as_str(), learned[0]["source"].as_str()), (Some("said"), Some("says_wrong")));
    let note_id = learned[0]["id"].as_str().expect("an id").to_owned();
    // The next chat in the project starts with it.
    let notes_of = |chat: String| {
        let spec = agents.started().into_iter().find(|s| s.worker_id == chat).expect("the chat");
        spec.notes
    };
    let packed = rig::focused_chat(&app, &cwd, "Run the linter and the tests.").await;
    frames.until(Duration::from_secs(20), |f| rig::went(f, &packed, "IDLE")).await.expect("the turn ends");
    assert!(notes_of(packed).iter().any(|n| n.contains(&note_id)), "the pack holds the note");

    // Learning off: the next correction teaches nothing.
    let off = json!({"learning": false, "reminders": false});
    let (status, set) = rig::call(&app, Method::Put, "/api/memory/settings", Some(off.clone())).await;
    assert_eq!((status, set), (200, off));
    say(&app, &mut frames, &chat, "No, that is wrong again: keep the old parser.").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let pending = app.store().read(|tx| tx.mem_moments().count_pending()).await.expect("reads");
    assert_eq!((notes(&app).await.len(), pending), (1, 0), "no note and nothing waiting");

    // Reminders off: a new chat in the project starts without a pack.
    let second = rig::focused_chat(&app, &cwd, "Run the linter and the tests.").await;
    frames.until(Duration::from_secs(20), |f| rig::went(f, &second, "IDLE")).await.expect("the turn ends");
    assert!(notes_of(second).is_empty(), "no pack");
    app.shutdown(Duration::from_secs(5)).await;
}
