//! An App's review and tests: Eos starts the read-only reviewer in the
//! build run with the App as outside text and tests the App in the probe
//! with a fake bridge; only both passing makes the version the candidate,
//! and the builder hears how it went either way.

use std::time::Duration;

use eos_core::Error;
use eos_core::surface::ProbeFinding;
use eos_runtime::router::Router;
use eos_surface::VersionStatus;
use serde_json::{Value, json};

use crate::apps::{GAME, app, game, row};
use crate::rig::Rig;

async fn checks(rig: &Rig, n: i64) -> Value {
    serde_json::from_str(&row(rig, n).await.checks_json).expect("json")
}

/// Waits until version `n`'s reviewer started and its tests are in.
async fn both_started(rig: &Rig, n: i64) -> Value {
    for _ in 0..200 {
        let checks = checks(rig, n).await;
        if checks["reviewer"].is_string() && !checks["tests"].is_null() {
            return checks;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the review and the tests of version {n} never started: {}", checks(rig, n).await);
}

async fn proposed(rig: &Rig) -> Value {
    rig.module.tools().app_propose("w-lead", app(GAME), "A level editor".into()).await.expect("scanned");
    let checks = both_started(rig, 1).await;
    // The engine writes the reviewer's session as it starts it.
    rig.session("rt-1", "rn-p", "w-reviewer1", "app_reviewer");
    checks
}

async fn review(rig: &Rig, worker: &str, verdict: Value) -> Result<String, Error> {
    rig.module.tools().app_review(worker, verdict).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reviewed_and_tested_app_becomes_the_candidate_and_its_builder_hears_it() {
    let rig = game().await;
    let checks = proposed(&rig).await;
    assert_eq!(checks["tests"]["passed"], true);
    assert_eq!(checks["tests"]["width"], 360);
    assert_eq!(row(&rig, 1).await.status, VersionStatus::Checking, "the tests alone do not show it");

    let started = rig.reviews.started();
    assert_eq!(started.len(), 1);
    let reviewer = &started[0];
    assert_eq!((reviewer.run_id.as_str(), reviewer.model.as_str(), reviewer.effort.as_str()), ("rn-p", "opus", "high"));
    assert_eq!(reviewer.fence.allow, ["Read", "Grep", "Glob", "LS"]);
    assert!(reviewer.brief.starts_with("You review one App."), "its list first");
    assert!(reviewer.brief.contains("<untrusted source=\"app\">"), "the App is outside text");
    assert!(reviewer.brief.contains("This App can "), "with the line Eos writes under it");
    assert!(reviewer.brief.contains("levels/*.json"));

    // The test document: the App in a sandboxed frame, under the frame's policy.
    let loaded = rig.probe.loaded();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].script, "window.__eosAppTests");
    let raw = Router::builder().routes(rig.module.raw_routes()).build().expect("raw router");
    let path = loaded[0].url.trim_start_matches("http://raw.eos.localhost");
    let (status, headers, doc) = rig.fetch(&raw, path).await;
    assert_eq!(status, 200);
    let csp = headers.iter().find(|(k, _)| k == "content-security-policy").map(|(_, v)| v.clone()).expect("a policy");
    assert!(csp.contains("connect-src 'none'") && csp.contains("default-src 'none'"), "{csp}");
    assert!(doc.contains("<iframe id=\"eos-app\" sandbox=\"allow-scripts\""), "scripts alone, no origin of its own");
    assert!(doc.contains("window.__eosTests = async (eosTest)"), "the builder's tests run in the frame");

    let line = review(&rig, "w-reviewer1", json!({"verdict": "pass", "findings": []})).await.expect("recorded");
    assert_eq!(line, "verdict recorded: pass for version 1");
    let v1 = row(&rig, 1).await;
    assert_eq!(v1.status, VersionStatus::Candidate);
    let kept: Value = serde_json::from_str(&v1.checks_json).expect("json");
    assert_eq!((kept["passed"].clone(), kept["review"]["verdict"].clone()), (json!(true), json!("pass")));
    let told = rig.reviews.told();
    assert_eq!(told.len(), 1);
    assert_eq!((told[0].0.as_str(), told[0].1.as_str()), ("rn-p", "w-lead"));
    assert!(told[0].2.contains("passed its review and its tests"), "{}", told[0].2);

    let again = review(&rig, "w-reviewer1", json!({"verdict": "fail", "findings": []})).await;
    assert!(matches!(again, Err(Error::Validation(_))), "a fail names what it breaks");
    let late = review(&rig, "w-reviewer1", json!({"verdict": "pass", "findings": []})).await;
    assert!(matches!(late, Err(Error::Validation(_))), "a version that moved on takes no verdict: {late:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_review_or_failed_tests_discard_the_version_with_their_findings() {
    let rig = game().await;
    proposed(&rig).await;
    let finding = json!({"rule": "imitation", "where": "html, #go", "why": "It looks like Eos's send button."});
    review(&rig, "w-reviewer1", json!({"verdict": "fail", "findings": [finding]})).await.expect("recorded");
    let v1 = row(&rig, 1).await;
    assert_eq!(v1.status, VersionStatus::Discarded);
    let (_, shown) = rig.ask(eos_runtime::http::Method::Get, "/api/surfaces/sf-app", None).await;
    assert_eq!(shown["candidateVersion"], Value::Null, "{shown}");
    let told = rig.reviews.told();
    assert!(told[0].2.contains("- review, imitation at html, #go: It looks like Eos's send button."), "{}", told[0].2);

    // The review passes, but the probe found an error.
    rig.probe.finding(vec![ProbeFinding {
        check: "undeclared".into(),
        part: None,
        detail: "calls `probe.erase`, which its manifest does not declare".into(),
    }]);
    rig.module.tools().app_propose("w-lead", app(GAME), "Again".into()).await.expect("scanned");
    let checks = both_started(&rig, 2).await;
    rig.session("rt-1", "rn-p", "w-reviewer2", "app_reviewer");
    assert_eq!(checks["tests"]["passed"], false);
    review(&rig, "w-reviewer2", json!({"verdict": "pass", "findings": []})).await.expect("recorded");
    assert_eq!(row(&rig, 2).await.status, VersionStatus::Discarded);
    let told = rig.reviews.told();
    assert!(told[1].2.contains("- tests, undeclared: calls `probe.erase`"), "{}", told[1].2);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_reviewer_of_the_waiting_version_gives_a_verdict_and_every_problem_is_named() {
    let rig = game().await;
    proposed(&rig).await;
    for worker in ["w-lead", "w-other", "w-nobody"] {
        let refused = review(&rig, worker, json!({"verdict": "pass", "findings": []})).await;
        assert!(matches!(refused, Err(Error::Validation(_))), "{worker}: {refused:?}");
    }
    rig.session("rt-1", "rn-p", "w-reviewer9", "app_reviewer");
    let other = review(&rig, "w-reviewer9", json!({"verdict": "pass", "findings": []})).await;
    assert!(matches!(other, Err(Error::Validation(_))), "a reviewer not started for this version: {other:?}");
    let Err(Error::Validation(problems)) =
        review(&rig, "w-reviewer1", json!({"verdict": "maybe", "findings": [{"rule": "reach"}]})).await
    else {
        panic!("taken")
    };
    assert_eq!(problems, "verdict: is `pass` or `fail`\nfindings[0]: has a rule, where and why");
    assert_eq!(row(&rig, 1).await.status, VersionStatus::Checking);
}

#[tokio::test(flavor = "multi_thread")]
async fn without_eos_window_the_tests_wait_and_a_passing_review_shows_nothing() {
    let rig = game().await;
    rig.probe.set_available(false);
    let checks = proposed(&rig).await;
    assert_eq!(checks["tests"]["waiting"], "Waiting for Eos's window");
    review(&rig, "w-reviewer1", json!({"verdict": "pass", "findings": []})).await.expect("recorded");
    assert_eq!(row(&rig, 1).await.status, VersionStatus::Checking, "never shown before its tests pass");
}
