//! What Eos can reach for the user (`list_capabilities`, `call_capability`):
//! every call goes through the capability service, which reads the
//! capabilities fresh, so one installed after a session started is there on
//! its next call. Input and output never reach a log.

use std::sync::Arc;

use eos_contracts::tool_scope::CALL_CAPABILITY_TOOL;
use eos_core::capability::{
    ActionCall, ActionCaller, ActionDescription, ActionError, CapabilityCalls, CapabilityDescription,
};
use eos_core::{BoxFuture, Error};
use eos_domain::capability::health::StateCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::schema::{object, record, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

fn action_json(action: &ActionDescription) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), action.name.clone().into());
    out.insert("summary".into(), action.summary.clone().into());
    out.insert("class".into(), json!(action.class));
    if let Some(input) = &action.input {
        out.insert("input".into(), input.clone());
    }
    out.into()
}

/// One capability as the model reads it; what it does not have is left out.
fn capability_json(capability: &CapabilityDescription) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), capability.id.clone().into());
    out.insert("name".into(), capability.name.clone().into());
    out.insert("summary".into(), capability.summary.clone().into());
    out.insert("state".into(), capability.state.as_str().into());
    if let Some(code) = &capability.state_code {
        out.insert("stateCode".into(), StateCode::as_string(code).into());
    }
    if let Some(setup) = &capability.setup {
        out.insert("setup".into(), setup.clone().into());
    }
    out.insert("actions".into(), capability.actions.iter().map(action_json).collect());
    if let Some(instructions) = &capability.instructions {
        out.insert("instructions".into(), instructions.clone().into());
    }
    out.into()
}

struct List(Arc<dyn CapabilityCalls>);

#[derive(Deserialize)]
struct ListArgs {
    id: Option<String>,
}

impl Handler for List {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ListArgs { id } = args(input)?;
            let described = match self.0.describe(call.self_id, id.as_deref()).await {
                Ok(described) => described,
                // The same words a call of an unknown capability reads.
                Err(Error::NotFound { .. }) => return Err(Failure(ActionError::NotFound.to_string())),
                Err(e) => return Err(e.into()),
            };
            Ok(Output::Json(described.iter().map(capability_json).collect()))
        })
    }
}

struct CallAction(Arc<dyn CapabilityCalls>);

#[derive(Deserialize)]
struct CallArgs {
    capability: String,
    action: String,
    input: Value,
}

impl Handler for CallAction {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let CallArgs { capability, action, input } = args(input)?;
            let call = ActionCall {
                capability,
                action,
                input,
                caller: ActionCaller::Agent { worker_id: call.self_id.to_owned() },
                idempotency_key: None,
            };
            match self.0.call(call).await {
                Ok(result) => Ok(Output::Json(result.output)),
                Err(e) => Err(Failure(e.to_string())),
            }
        })
    }
}

pub(crate) fn specs(calls: &Arc<dyn CapabilityCalls>) -> Vec<Spec> {
    let list = Spec::new(
        "list_capabilities",
        object(vec![(
            "id",
            string().optional().describe("One capability's id: adds each action's input and how to use it."),
        )]),
        List(calls.clone()),
    );
    let call = Spec::new(
        CALL_CAPABILITY_TOOL,
        object(vec![
            ("capability", string().min(1).describe("The capability's id, as list_capabilities gives it.")),
            ("action", string().min(1).describe("The action's name.")),
            ("input", record().default(json!({})).describe("What the action takes, as its input schema says.")),
        ]),
        CallAction(calls.clone()),
    );
    vec![list, call]
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use eos_capabilities::Install;
    use eos_core::capability::ActionError;
    use eos_domain::capability::manifest::parse;
    use eos_testkit::{FakeBuiltin, FakeCapabilitySecrets, FakeFeatures, TempStore};
    use serde_json::{Value, json};

    use crate::tests::{Bench, bench_with, call};

    const GITHUB: &str = r#"
id = "github"
name = "GitHub"
version = "1"
summary = "Pull requests and reviews on GitHub."
form = "builtin"
works = "any_mac"

[[secrets]]
name = "token"
label = "GitHub sign-in"

[[actions]]
name = "get_pull_request"
summary = "Read a pull request."
class = "read"
input = { type = "object", required = ["number"], properties = { number = { type = "integer" } } }

[[actions]]
name = "post_review"
summary = "Post a review."
class = "speak"
recipient = "input:/pull"
input = { type = "object", properties = { pull = { type = "string" } } }
"#;

    const NOTES: &str = r#"
id = "notes-db"
name = "Notes"
version = "1.0.0"
summary = "Reads your notes."
form = "script"
works = "this_mac"

[[actions]]
name = "list_notes"
summary = "List notes."
class = "read"
run = ["/bin/sh", "list.sh"]
"#;

    async fn github(signed_in: bool) -> (Bench, Arc<FakeBuiltin>) {
        let builtin = Arc::new(FakeBuiltin::new(GITHUB).answering("get_pull_request", Ok(json!({"number": 7}))));
        let secrets = if signed_in {
            FakeCapabilitySecrets::new().with("github", "token", "gho_planted_secret_1")
        } else {
            FakeCapabilitySecrets::new()
        };
        let bench = bench_with(FakeFeatures::new([]), TempStore::new(), vec![builtin.clone()], secrets);
        bench.capabilities.start().await.expect("starts");
        (bench, builtin)
    }

    fn json_of(text: &str) -> Value {
        serde_json::from_str(text).expect("json")
    }

    #[tokio::test]
    async fn an_agent_lists_what_it_may_call_and_one_capability_in_full() {
        let (bench, _) = github(true).await;
        let list = bench.tool("orchestrator", "list_capabilities");
        let all = call(&list, "o-self0001", json!({})).await;
        assert!(!all.is_error, "{}", all.text);
        assert_eq!(
            json_of(&all.text),
            json!([{
                "id": "github", "name": "GitHub", "summary": "Pull requests and reviews on GitHub.", "state": "ready",
                "actions": [
                    {"name": "get_pull_request", "summary": "Read a pull request.", "class": "read"},
                    {"name": "post_review", "summary": "Post a review.", "class": "speak"},
                ],
            }])
        );
        let one = call(&list, "o-self0001", json!({"id": "github"})).await;
        let actions = &json_of(&one.text)[0]["actions"];
        assert_eq!(actions[0]["input"]["required"], json!(["number"]), "{}", one.text);
    }

    #[tokio::test]
    async fn what_is_missing_is_listed_with_the_step_the_user_takes() {
        let (bench, _) = github(false).await;
        let listed = call(&bench.tool("worker", "list_capabilities"), "w-self0001", json!({})).await;
        let github = &json_of(&listed.text)[0];
        assert_eq!(
            (github["state"].as_str(), github["stateCode"].as_str()),
            (Some("needs_setup"), Some("secret_missing:token"))
        );
        assert_eq!(github["setup"], "The user enters GitHub sign-in in Eos › Capabilities.");
    }

    #[tokio::test]
    async fn an_agent_calls_an_action_as_itself() {
        let (bench, builtin) = github(true).await;
        let reply = call(
            &bench.tool("focused", "call_capability"),
            "w-self0001",
            json!({"capability": "github", "action": "get_pull_request", "input": {"number": 7}}),
        )
        .await;
        assert_eq!((json_of(&reply.text), reply.is_error), (json!({"number": 7}), false));
        assert_eq!(builtin.calls()[0].input, json!({"number": 7}));
        let row = "SELECT COUNT(*) FROM capability_calls WHERE caller_kind = 'agent' AND worker_id = 'w-self0001'";
        assert_eq!(bench.store.count(row), 1);
    }

    #[tokio::test]
    async fn a_capability_installed_after_the_session_started_is_callable_from_it() {
        let (bench, _) = github(true).await;
        let tool = bench.tool("worker", "call_capability");
        let input = json!({"capability": "notes-db", "action": "list_notes"});
        let before = call(&tool, "w-self0001", input.clone()).await;
        assert_eq!((before.text, before.is_error), (ActionError::NotFound.to_string(), true));

        bench.store.home.write("forge/notes/capability.toml", NOTES);
        let install = Install {
            package_dir: bench.store.home.join("forge/notes"),
            manifest: parse(NOTES).expect("a manifest"),
            hash: "h-1".into(),
            origin: "forge".into(),
            source: "rn-0a1b2c3d4e5f".into(),
        };
        bench.capabilities.install(install).await.expect("installs");
        let after = call(&tool, "w-self0001", input).await;
        assert_eq!((after.text.as_str(), after.is_error), ("{}", false));
        assert_eq!(bench.runner.runs().len(), 1);
    }

    #[tokio::test]
    async fn each_failure_reads_its_fixed_text() {
        let (bench, _) = github(false).await;
        let tool = bench.tool("orchestrator", "call_capability");
        let cases = [
            (json!({"capability": "mail", "action": "send"}), ActionError::NotFound.to_string()),
            (
                json!({"capability": "github", "action": "get_pull_request", "input": {"number": 7}}),
                ActionError::NotReady("secret_missing:token".into()).to_string(),
            ),
        ];
        for (input, text) in cases {
            let reply = call(&tool, "o-self0001", input).await;
            assert_eq!((reply.text, reply.is_error), (text, true));
        }
        let unknown = call(&bench.tool("orchestrator", "list_capabilities"), "o-self0001", json!({"id": "mail"})).await;
        assert_eq!((unknown.text, unknown.is_error), (ActionError::NotFound.to_string(), true));

        let (bench, _) = github(true).await;
        let tool = bench.tool("orchestrator", "call_capability");
        let bad = call(&tool, "o-self0001", json!({"capability": "github", "action": "get_pull_request"})).await;
        assert!(bad.is_error && bad.text.starts_with("Input validation error:"), "{}", bad.text);
    }
}
