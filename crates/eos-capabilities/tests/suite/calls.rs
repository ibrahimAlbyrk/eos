//! The call path: a built-in end to end, the refusals, and a package
//! installed while a call was under way.

use std::sync::Arc;

use eos_contracts::ActionClass;
use eos_core::BoxFuture;
use eos_core::capability::{
    ActionCaller, ActionError, CapabilityCalls, CapabilityGrants, CapabilityRegistry, Grant, GrantedAction,
};
use eos_domain::untrusted::wrap;
use eos_testkit::{FakeActionRunner, FakeBuiltin};
use serde_json::json;

use crate::rig::{GITHUB, SECRET, Setup, agent_call, github_rig, notes, rig};

#[tokio::test]
async fn a_built_in_call_is_checked_run_scrubbed_marked_and_recorded() {
    let github = Arc::new(
        FakeBuiltin::new(GITHUB)
            .answering("get_pull_request", Ok(json!({ "number": 7, "title": format!("Leaks {SECRET} here") }))),
    );
    let rig = github_rig(github.clone()).await;

    let result =
        rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await.expect("answers");

    assert_eq!(result.output["number"], 7);
    assert_eq!(result.output["title"], wrap("github:get_pull_request", "Leaks [secret] here"));
    assert!(!result.output.to_string().contains(SECRET));
    let calls = github.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].secrets, ["token"], "the token reaches the code by name");
    assert_eq!(calls[0].input, json!({ "number": 7 }));
    let row = format!(
        "SELECT COUNT(*) FROM capability_calls WHERE id = '{}' AND capability_id = 'github' AND action = \
         'get_pull_request' AND class = 'read' AND caller_kind = 'agent' AND worker_id = 'w-1' AND outcome = 'ok' \
         AND error_kind IS NULL AND version IS NULL AND started_at = 1000",
        result.call_id
    );
    assert_eq!(rig.temp.count(&row), 1);
    assert!(rig.changes().iter().all(|change| !change.contains("needs")), "a good call changes no state");
}

#[tokio::test]
async fn outside_text_is_marked_only_for_a_model() {
    let github =
        Arc::new(FakeBuiltin::new(GITHUB).answering("get_pull_request", Ok(json!({ "number": 7, "title": "Fix" }))));
    let rig = github_rig(github).await;

    let for_agent = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    let mut candidates = agent_call("github", "get_pull_request", json!({ "number": 7 }));
    candidates.caller = ActionCaller::Candidates;
    let for_screen = rig.service.call(candidates).await;

    assert_eq!(for_agent.expect("answers").output["title"], wrap("github:get_pull_request", "Fix"));
    assert_eq!(for_screen.expect("answers").output["title"], "Fix");
}

/// Grants only the read action, of class read at most.
struct ReadOnly;

impl CapabilityGrants for ReadOnly {
    fn grant<'a>(&'a self, _worker_id: &'a str) -> BoxFuture<'a, Option<Grant>> {
        let actions = vec![GrantedAction { capability: "github".into(), action: "get_pull_request".into() }];
        Box::pin(std::future::ready(Some(Grant { actions, max_class: ActionClass::Read })))
    }
}

#[tokio::test]
async fn an_action_outside_the_grant_is_refused_and_recorded_as_denied() {
    let github = Arc::new(FakeBuiltin::new(GITHUB));
    let rig = rig(Setup {
        builtins: vec![github.clone()],
        secrets: eos_testkit::FakeCapabilitySecrets::new().with("github", "token", SECRET),
        grants: Arc::new(ReadOnly),
        ..Setup::default()
    })
    .await;

    let refused = rig.service.call(agent_call("github", "post_review", json!({}))).await;
    assert_eq!(refused, Err(ActionError::NotGranted));
    assert_eq!(refused.expect_err("refused").to_string(), "This action is not granted to you here.");
    rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 1 }))).await.expect("granted");

    let mut surface = agent_call("github", "post_review", json!({}));
    surface.caller = ActionCaller::Surface { id: "sf-0a1b2c3d4e5f".into() };
    assert_eq!(rig.service.call(surface).await, Err(ActionError::NotGranted), "a surface only reads");

    assert_eq!(github.calls().len(), 1, "only the granted call ran");
    let denied = "SELECT COUNT(*) FROM capability_calls WHERE outcome = 'denied' AND error_kind = 'not_granted'";
    assert_eq!(rig.temp.count(denied), 2);
    let described = rig.service.describe("w-1", None).await.expect("described");
    let names: Vec<&str> = described[0].actions.iter().map(|action| action.name.as_str()).collect();
    assert_eq!(names, ["get_pull_request"], "an agent is told only what it may call");
}

#[tokio::test]
async fn a_capability_that_needs_setting_up_is_not_called() {
    let github = Arc::new(FakeBuiltin::new(GITHUB));
    let rig = rig(Setup { builtins: vec![github.clone()], ..Setup::default() }).await;

    let refused = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(refused, Err(ActionError::NotReady("secret_missing:token".into())));
    assert_eq!(
        refused.expect_err("refused").to_string(),
        "This capability is not ready (secret_missing:token). Call list_capabilities to see what the user must do."
    );
    assert!(github.calls().is_empty());
    let described = rig.service.describe("w-1", None).await.expect("described");
    assert_eq!(described[0].setup.as_deref(), Some("The user enters GitHub sign-in in Eos › Capabilities."));
    let row = "SELECT COUNT(*) FROM capability_calls WHERE outcome = 'error' AND error_kind = 'not_ready'";
    assert_eq!(rig.temp.count(row), 1);
}

#[tokio::test]
async fn input_that_breaks_the_schema_reads_as_the_tools_errors_do() {
    let github = Arc::new(FakeBuiltin::new(GITHUB));
    let rig = github_rig(github.clone()).await;

    let refused = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": "seven" }))).await;
    assert_eq!(
        refused.expect_err("refused").to_string(),
        "Input validation error: Invalid arguments for github.get_pull_request: number: Expected number, received \
         string"
    );
    assert!(github.calls().is_empty());
}

#[tokio::test]
async fn an_unknown_capability_or_action_is_not_found_and_not_recorded() {
    let rig = github_rig(Arc::new(FakeBuiltin::new(GITHUB))).await;
    assert_eq!(rig.service.call(agent_call("mail", "send", json!({}))).await, Err(ActionError::NotFound));
    assert_eq!(rig.service.call(agent_call("github", "merge", json!({}))).await, Err(ActionError::NotFound));
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM capability_calls"), 0);
}

#[tokio::test]
async fn an_output_that_breaks_its_schema_fails_the_call() {
    let github =
        Arc::new(FakeBuiltin::new(GITHUB).answering("get_pull_request", Ok(json!({ "number": "not a number" }))));
    let rig = github_rig(github).await;
    let failed = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(failed, Err(ActionError::Failed { kind: eos_core::capability::FailureKind::Output }));
    let row = "SELECT COUNT(*) FROM capability_calls WHERE outcome = 'error' AND error_kind = 'output'";
    assert_eq!(rig.temp.count(row), 1);
}

#[tokio::test]
async fn a_capability_installed_while_a_call_runs_is_callable_on_the_next_call() {
    let github = Arc::new(FakeBuiltin::new(GITHUB).held());
    let rig = rig(Setup {
        builtins: vec![github.clone()],
        secrets: eos_testkit::FakeCapabilitySecrets::new().with("github", "token", SECRET),
        runner: FakeActionRunner::new().answering("notes-db", "list_notes", Ok(json!({ "notes": 3 }))),
        ..Setup::default()
    })
    .await;
    let service = rig.service.clone();
    let running =
        tokio::spawn(
            async move { service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await },
        );
    while github.calls().is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }

    rig.install(&notes("1.0.0"), "h-1").await;
    let listed = rig.service.call(agent_call("notes-db", "list_notes", json!({ "q": "x" }))).await.expect("callable");
    assert_eq!(listed.output, json!({ "notes": 3 }));
    let runs = rig.runner.runs();
    assert_eq!(runs.len(), 1);
    assert_eq!((runs[0].version.as_str(), runs[0].env.as_slice()), ("1.0.0", ["NOTES_KEY".to_owned()].as_slice()));
    assert_eq!(rig.service.class_of("notes-db", "list_notes").await.expect("read"), Some(ActionClass::Read));

    github.release(1);
    running.await.expect("joins").expect("the first call ends well");
    let row = "SELECT COUNT(*) FROM capability_calls WHERE capability_id = 'notes-db' AND version = '1.0.0'";
    assert_eq!(rig.temp.count(row), 1);
}
