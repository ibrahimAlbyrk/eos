//! Signing in by GitHub's device flow.

use eos_core::Clock;
use eos_core::capability::{BuiltinCapability, CapabilitySecrets, SignInError};
use eos_domain::capability::health::{Event, StateCode};
use eos_testkit::{FakeGitHub, GITHUB_DEVICE_CODE, GITHUB_TOKEN, GITHUB_USER_CODE};
use serde_json::json;

use crate::rig::{ctx, rig, rig_with};

#[tokio::test]
async fn the_flow_waits_while_pending_slows_down_when_told_and_keeps_the_token() {
    let rig = rig();
    rig.fake.device_answers(vec![
        json!({ "error": "authorization_pending" }),
        json!({ "error": "slow_down", "interval": 10 }),
        FakeGitHub::granted(),
    ]);
    let sign_in = rig.github.device_sign_in().expect("GitHub signs in by a code");
    let code = sign_in.start().await.expect("a code");
    assert_eq!(*code.user_code, GITHUB_USER_CODE);
    assert_eq!(code.verification_uri, "https://github.com/login/device");
    assert_eq!(code.expires_at, rig.clock.now_ms() + 900_000, "codes live 15 minutes");
    assert!(!format!("{code:?}").contains(GITHUB_USER_CODE) && !format!("{code:?}").contains(GITHUB_DEVICE_CODE));

    let github = rig.github.clone();
    let finished = tokio::spawn(async move { github.device_sign_in().expect("signs in").finish(&code).await });
    assert_eq!(rig.next_wait().await, 5_000, "GitHub's interval");
    rig.sleeper.wake();
    assert_eq!(rig.next_wait().await, 5_000, "still pending");
    rig.sleeper.wake();
    assert_eq!(rig.next_wait().await, 10_000, "slow_down adds 5 s");
    rig.sleeper.wake();
    assert_eq!(finished.await.expect("joins"), Ok(rig.fake.login()), "the login is the account's label");

    let kept = rig.secrets.read("github", "token").await.expect("reads").expect("kept");
    assert_eq!(kept.as_str(), GITHUB_TOKEN);
    let calls = rig.fake.calls();
    assert_eq!(calls[0].path, "/login/device/code");
    assert_eq!(calls[0].body, json!({ "client_id": "Iv1.fake", "scope": "repo" }));
    let polls: Vec<_> = calls.iter().filter(|call| call.path == "/login/oauth/access_token").collect();
    assert_eq!(polls.len(), 3);
    assert_eq!(polls[0].body["grant_type"], "urn:ietf:params:oauth:grant-type:device_code");
    assert_eq!(calls.last().map(|call| (call.path.as_str(), call.signed_in)), Some(("/user", true)));
}

#[tokio::test]
async fn an_expired_or_refused_code_ends_the_sign_in_and_keeps_nothing() {
    let rig = rig();
    let sign_in = rig.github.device_sign_in().expect("signs in");
    rig.fake.device_answers(vec![json!({ "error": "expired_token" })]);
    let code = sign_in.start().await.expect("a code");
    let github = rig.github.clone();
    let finished = tokio::spawn(async move { github.device_sign_in().expect("signs in").finish(&code).await });
    rig.next_wait().await;
    rig.sleeper.wake();
    assert_eq!(finished.await.expect("joins"), Err(SignInError::Expired));

    let code = sign_in.start().await.expect("a code");
    rig.clock.advance(900_000);
    assert_eq!(sign_in.finish(&code).await, Err(SignInError::Expired), "out of time: no poll");

    rig.fake.device_answers(vec![json!({ "error": "access_denied" })]);
    let code = sign_in.start().await.expect("a code");
    let github = rig.github.clone();
    let finished = tokio::spawn(async move { github.device_sign_in().expect("signs in").finish(&code).await });
    rig.next_wait().await;
    rig.sleeper.wake();
    assert_eq!(finished.await.expect("joins"), Err(SignInError::Denied));
    assert_eq!(rig.secrets.read("github", "token").await.expect("reads"), None);
}

#[tokio::test]
async fn without_a_client_id_nothing_starts_and_the_check_asks_for_setup() {
    let rig = rig_with(" ");
    let sign_in = rig.github.device_sign_in().expect("signs in");
    assert_eq!(sign_in.start().await.map(drop), Err(SignInError::ClientIdMissing));
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Missing(StateCode::ClientIdMissing));
    assert!(rig.fake.calls().is_empty(), "GitHub was never asked");
}

#[tokio::test]
async fn a_sign_in_github_does_not_answer_ends_after_thirty_seconds_and_polls_stop_at_the_code_s_end() {
    let rig = rig();
    rig.fake.hang();
    let github = rig.github.clone();
    let started = tokio::spawn(async move { github.device_sign_in().expect("signs in").start().await.map(drop) });
    assert_eq!(rig.next_wait().await, 30_000);
    rig.sleeper.wake();
    assert_eq!(started.await.expect("joins"), Err(SignInError::Failed), "no code came");

    let fresh = rig_with("Iv1.fake");
    let code = fresh.github.device_sign_in().expect("signs in").start().await.expect("a code");
    fresh.fake.hang();
    let (github, clock) = (fresh.github.clone(), fresh.clock.clone());
    let finished = tokio::spawn(async move { github.device_sign_in().expect("signs in").finish(&code).await });
    assert_eq!(fresh.next_wait().await, 5_000, "GitHub's interval");
    fresh.sleeper.wake();
    assert_eq!(fresh.next_wait().await, 30_000, "the poll is bounded");
    clock.advance(900_000);
    fresh.sleeper.wake();
    assert_eq!(finished.await.expect("joins"), Err(SignInError::Expired), "the code ran out while GitHub was silent");
}
