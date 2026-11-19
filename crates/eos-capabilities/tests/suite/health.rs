//! Health: what calls and checks do to a capability's state, announced
//! once the write that keeps it commits.

use std::sync::Arc;

use eos_core::capability::{ActionError, CapabilityCalls, CapabilityRegistry, FailureKind};
use eos_domain::capability::health::{Event, Health, HealthState, StateCode};
use eos_testkit::FakeBuiltin;
use serde_json::json;

use crate::rig::{GITHUB, Setup, agent_call, github_rig, notes, rig};

#[tokio::test]
async fn an_auth_failure_asks_for_sign_in_and_a_good_check_brings_it_back() {
    let github = Arc::new(
        FakeBuiltin::new(GITHUB)
            .answering("get_pull_request", Err(ActionError::Failed { kind: FailureKind::Unauthorized })),
    );
    let rig = github_rig(github.clone()).await;
    assert_eq!(rig.changes(), [r#"{"id":"github","state":"ready"}"#], "its row, made at start");

    let failed = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(failed, Err(ActionError::Failed { kind: FailureKind::Unauthorized }));
    let state = rig.service.state("github").await.expect("read").expect("there");
    assert_eq!((state.state, state.code), (HealthState::NeedsSignIn, Some(StateCode::Http401)));
    assert_eq!(rig.changes()[1], r#"{"id":"github","state":"needs_sign_in","stateCode":"http_401"}"#);
    let refused = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(refused, Err(ActionError::NotReady("http_401".into())));
    assert_eq!(github.calls().len(), 1, "a capability that needs sign-in is not called");

    github.set_health(Event::Passed);
    let health = rig.service.check("github").await.expect("checks");
    assert_eq!(health, Health::ready());
    assert_eq!(rig.changes()[2], r#"{"id":"github","state":"ready"}"#);
    assert_eq!(rig.changes().len(), 3);
    rig.service.check("github").await.expect("checks again");
    assert_eq!(rig.changes().len(), 3, "a check that changes nothing announces nothing");
}

#[tokio::test]
async fn a_rate_limit_degrades_a_capability_that_still_takes_calls() {
    let github = Arc::new(
        FakeBuiltin::new(GITHUB).answering("get_pull_request", Err(ActionError::RateLimited { retry_after_s: 30 })),
    );
    let rig = github_rig(github.clone()).await;
    let limited = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(limited.expect_err("limited").to_string(), "The service is limiting requests. Try again in 30 s.");
    let state = rig.service.state("github").await.expect("read").expect("there");
    assert_eq!(state.state, HealthState::Degraded);

    github.answer("get_pull_request", Ok(json!({ "number": 7, "title": "t" })));
    rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await.expect("still called");
    assert_eq!(rig.service.state("github").await.expect("read").expect("there"), Health::ready());
}

#[tokio::test]
async fn a_package_whose_files_changed_breaks_and_its_code_does_not_run() {
    let rig = rig(Setup::default()).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    rig.service.call(agent_call("notes-db", "list_notes", json!({}))).await.expect("runs");

    rig.files.tamper("notes-db", "1.0.0", "h-edited");
    let refused = rig.service.call(agent_call("notes-db", "list_notes", json!({}))).await;
    assert_eq!(refused, Err(ActionError::NotReady("hash_mismatch".into())));
    assert_eq!(rig.runner.runs().len(), 1, "the edited package never ran");
    let state = rig.service.state("notes-db").await.expect("read").expect("there");
    assert_eq!((state.state, state.code), (HealthState::Broken, Some(StateCode::HashMismatch)));
    let check = rig.service.check("notes-db").await.expect("checks");
    assert_eq!(check.state, HealthState::Broken, "a check of the same files keeps it broken");
}

/// The early check is asked for only once the failure is kept: a check that
/// ran sooner would be overwritten by the failure it was asked to look at.
#[tokio::test]
async fn an_early_check_is_asked_for_after_the_failure_is_kept() {
    let github = Arc::new(
        FakeBuiltin::new(GITHUB)
            .answering("get_pull_request", Err(ActionError::Failed { kind: FailureKind::Unauthorized })),
    );
    let rig = github_rig(github).await;
    let (service, announced) = (rig.service.clone(), rig.temp.announced.clone());
    let waiter = tokio::spawn(async move {
        let queued = service.early_checks().await;
        (queued, announced.list().len())
    });
    tokio::task::yield_now().await;
    let before = rig.temp.announced.list().len();
    let failed = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(failed, Err(ActionError::Failed { kind: FailureKind::Unauthorized }));
    let (queued, seen) = waiter.await.expect("joins");
    assert_eq!(queued, ["github"]);
    assert!(seen > before, "the move to needs_sign_in was announced before the check was asked for");
}

/// G10: the early check after a broken output passes for a built-in, since
/// a check does not look at outputs, and must not forgive the output.
#[tokio::test]
async fn three_broken_outputs_in_a_row_break_it_though_the_early_checks_pass() {
    let github =
        Arc::new(FakeBuiltin::new(GITHUB).answering("get_pull_request", Ok(json!({ "number": "not a number" }))));
    let rig = github_rig(github.clone()).await;
    for _ in 0..2 {
        let failed = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
        assert_eq!(failed, Err(ActionError::Failed { kind: FailureKind::Output }));
        assert_eq!(rig.service.early_checks().await, ["github"]);
        let checked = rig.service.check("github").await.expect("checks");
        assert_eq!(checked.state, HealthState::Ready, "the check passed");
    }
    assert_eq!(github.checks(), 2);

    let failed = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(failed, Err(ActionError::Failed { kind: FailureKind::Output }));
    let state = rig.service.state("github").await.expect("read").expect("there");
    assert_eq!((state.state, state.code), (HealthState::Broken, Some(StateCode::OutputSchema)));
    assert_eq!(
        rig.changes().last().map(String::as_str),
        Some(r#"{"id":"github","state":"broken","stateCode":"output_schema"}"#)
    );
    let refused = rig.service.call(agent_call("github", "get_pull_request", json!({ "number": 7 }))).await;
    assert_eq!(refused, Err(ActionError::NotReady("output_schema".into())));
}
