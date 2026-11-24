//! Capabilities: a chat calls a capability whose answer quotes its secret, and the user
//! signs in to GitHub and to Slack. Neither the secret, nor GitHub's or Slack's tokens,
//! codes, state or account name reaches the log; the call and the sign-ins are told by
//! capability id.

use std::time::Duration;

use eos_app::App;
use eos_runtime::http::Method;
use eos_testkit::ScriptedRuntime;
use serde_json::json;

use crate::planted::{ECHO_SECRET, Planted, call_capability, sign_in_to_github};
use crate::{Area, rig};

pub(crate) async fn steps(app: &App, agents: &ScriptedRuntime, planted: &Planted) -> Area {
    let project = tempfile::tempdir().expect("a project");
    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let chat = rig::focused_chat(app, &cwd, "Read the echo note.").await;
    let mut frames = rig::Frames::new(rig::open_stream(app, "topics=worker:*").await.expect("a stream"));
    let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;

    let input = json!({ "capability": "echo", "action": "read_note", "input": {} });
    let reply = call_capability(app, agents, &chat, input).await;
    assert!(!reply.is_error && reply.text.contains("[secret]") && !reply.text.contains(ECHO_SECRET), "{}", reply.text);
    let signed_in = sign_in_to_github(app).await;
    assert_eq!(signed_in["state"], "signed_in");
    let slack = planted.sign_in_to_slack(app).await;
    assert_eq!(slack["state"], "signed_in", "{slack}");
    let (status, _) = rig::call(app, Method::Delete, &format!("/workers/{chat}"), None).await;
    assert!(status < 300);

    let told = [
        "capability call",
        "capability=echo",
        "signed in to GitHub",
        "signed in to Slack",
        "a capability sign-in ended",
    ];
    Area { planted: planted.values(), told: told.map(str::to_owned).to_vec() }
}
