//! A capability that keeps a secret and says it back, and GitHub on `FakeGitHub`: what the
//! tests that hold capability secrets out of logs, tool results and streams plant.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, CapabilityOptions};
use eos_contracts::SettingValue;
use eos_core::agent::{ToolCaller, ToolReply};
use eos_runtime::http::Method;
use eos_testkit::{
    FakeBuiltin, FakeCapabilitySecrets, FakeGitHub, GITHUB_DEVICE_CODE, GITHUB_TOKEN, GITHUB_USER_CODE, ScriptedRuntime,
};
use serde_json::{Value, json};

use crate::rig;

/// The capability's key, which its answer quotes.
pub(crate) const ECHO_SECRET: &str = "nk_PLANTED-capability-secret-heron";

const ECHO: &str = r#"
id = "echo"
name = "Echo"
version = "1"
summary = "Says back the note it keeps."
form = "builtin"
works = "any_mac"

[[secrets]]
name = "api_key"
label = "Echo key"

[[actions]]
name = "read_note"
summary = "Read the note."
class = "read"
output = { type = "object", properties = { note = { type = "string", untrusted = true } } }
"#;

pub(crate) struct Planted {
    github: Arc<FakeGitHub>,
    secrets: Arc<FakeCapabilitySecrets>,
    echo: Arc<FakeBuiltin>,
}

impl Planted {
    /// The echo capability with its key set, and GitHub ready to grant a sign-in.
    pub(crate) fn plant() -> Self {
        let github = Arc::new(FakeGitHub::new());
        github.set_device_interval(1);
        github.device_answers(vec![FakeGitHub::granted()]);
        let secrets = Arc::new(FakeCapabilitySecrets::new().with("echo", "api_key", ECHO_SECRET));
        let note = json!({ "note": format!("The key is {ECHO_SECRET}.") });
        let echo = Arc::new(FakeBuiltin::new(ECHO).answering("read_note", Ok(note)));
        Self { github, secrets, echo }
    }

    pub(crate) fn options(&self) -> CapabilityOptions {
        CapabilityOptions {
            secrets: Some(self.secrets.clone()),
            builtins: vec![self.echo.clone()],
            github: Some(self.github.clone()),
        }
    }

    /// What must never reach a log, a tool result or a frame: the key, GitHub's token and
    /// codes, and the account's name.
    pub(crate) fn values(&self) -> Vec<String> {
        vec![
            ECHO_SECRET.to_owned(),
            GITHUB_TOKEN.to_owned(),
            GITHUB_USER_CODE.to_owned(),
            GITHUB_DEVICE_CODE.to_owned(),
            self.github.login(),
        ]
    }
}

/// `call_capability` as the engine calls it for `chat`'s model, with the Eos preview on.
pub(crate) async fn call_capability(app: &App, agents: &ScriptedRuntime, chat: &str, input: Value) -> ToolReply {
    let preview = [("eos.preview".to_owned(), SettingValue::Flag(true))].into_iter().collect();
    app.settings().patch(preview).expect("the preview is on");
    let spec = agents.started().into_iter().find(|spec| spec.worker_id == chat).expect("the chat's session");
    let tools = app.tools().for_session(&spec);
    let tool = tools.iter().find(|tool| tool.definition().name == "call_capability").expect("the tool");
    tool.call(ToolCaller { worker_id: chat, call_id: "toolu_capability", subagent_id: None }, input).await
}

/// Signs in to GitHub as the dashboard does, and answers how the sign-in ended.
pub(crate) async fn sign_in_to_github(app: &App) -> Value {
    let (status, _) = rig::call(app, Method::Post, "/api/capabilities/github/sign-in", None).await;
    assert_eq!(status, 200);
    for _ in 0..200 {
        let (_, sign_in) = rig::call(app, Method::Get, "/api/capabilities/github/sign-in", None).await;
        if sign_in["state"] != "pending" {
            return sign_in;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the sign-in never ended");
}
