//! A capability that keeps a secret and says it back, GitHub on `FakeGitHub` and Slack on
//! `FakeSlack`: what the
//! tests that hold capability secrets out of logs, tool results and streams plant.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, CapabilityOptions};
use eos_core::agent::{ToolCaller, ToolReply};
use eos_runtime::http::Method;
use eos_testkit::{
    FakeBuiltin, FakeCapabilitySecrets, FakeGitHub, FakeSlack, GITHUB_DEVICE_CODE, GITHUB_TOKEN, GITHUB_USER_CODE,
    SLACK_CODE, ScriptedRuntime,
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

/// The Slack app the planted sign-in asks for, as `config.json` names it.
pub(crate) const SLACK_CLIENT_ID: &str = "1234.5678";

pub(crate) struct Planted {
    github: Arc<FakeGitHub>,
    slack: Arc<FakeSlack>,
    /// The state of the Slack sign-in, once it started.
    slack_state: std::sync::Mutex<Option<String>>,
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
        Self { github, slack: Arc::new(FakeSlack::new()), slack_state: Default::default(), secrets, echo }
    }

    pub(crate) fn options(&self) -> CapabilityOptions {
        CapabilityOptions {
            secrets: Some(self.secrets.clone()),
            builtins: vec![self.echo.clone()],
            github: Some(self.github.clone()),
            slack: Some(self.slack.clone()),
            ..CapabilityOptions::default()
        }
    }

    /// What must never reach a log, a tool result or a frame: the key, GitHub's token and
    /// codes, the account's name, and Slack's tokens, code, state and label.
    pub(crate) fn values(&self) -> Vec<String> {
        let mut values = vec![
            ECHO_SECRET.to_owned(),
            GITHUB_TOKEN.to_owned(),
            GITHUB_USER_CODE.to_owned(),
            GITHUB_DEVICE_CODE.to_owned(),
            self.github.login(),
            SLACK_CODE.to_owned(),
            "xoxe.xoxp-fake-1".to_owned(),
            "xoxe-1-fake-1".to_owned(),
            "Acme as me".to_owned(),
        ];
        values.extend(self.slack_state.lock().expect("the state").clone());
        values
    }

    /// Signs in to Slack as the dashboard and the browser do: Connect, then Slack's link
    /// back. Answers how the sign-in ended.
    pub(crate) async fn sign_in_to_slack(&self, app: &App) -> Value {
        let (status, started) = rig::call(app, Method::Post, "/api/capabilities/slack/sign-in", None).await;
        assert_eq!(status, 200, "{started}");
        let page = url::Url::parse(started["verificationUri"].as_str().expect("Slack's page")).expect("a page");
        let field = |name: &str| page.query_pairs().find(|(key, _)| key == name).map(|(_, v)| v.into_owned());
        self.slack.expect_challenge(&field("code_challenge").expect("a challenge"));
        let state = field("state").expect("a state");
        *self.slack_state.lock().expect("the state") = Some(state.clone());
        assert!(app.open_link(&format!("eos://sign-in/slack?code={SLACK_CODE}&state={state}")));
        for _ in 0..200 {
            let (_, sign_in) = rig::call(app, Method::Get, "/api/capabilities/slack/sign-in", None).await;
            if sign_in["state"] != "pending" {
                return sign_in;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the Slack sign-in never ended");
    }
}

/// `call_capability` as the engine calls it for `chat`'s model.
pub(crate) async fn call_capability(app: &App, agents: &ScriptedRuntime, chat: &str, input: Value) -> ToolReply {
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
