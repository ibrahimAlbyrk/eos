//! Signing in to GitHub by a code, with the GitHub capability itself on
//! `FakeGitHub`: start, pending, signed in and ready, ended by the user,
//! out of time, no client id, and who may ask.

use std::sync::Arc;

use eos_core::capability::{BuiltinCapability, CapabilitySecrets};
use eos_github::{GitHub, Parts};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::{
    FakeBuiltin, FakeCapabilitySecrets, FakeClock, FakeGitHub, FakeSleeper, GITHUB_TOKEN, GITHUB_USER_CODE,
};
use serde_json::{Value, json};

use crate::rig::{MAIL, Rig, rig_with};

const PATH: &str = "/api/capabilities/github/sign-in";

struct SignIn {
    rig: Rig,
    fake: Arc<FakeGitHub>,
    secrets: Arc<FakeCapabilitySecrets>,
    /// The waits between GitHub's polls.
    polls: Arc<FakeSleeper>,
}

async fn sign_in(client_id: &str) -> SignIn {
    let fake = Arc::new(FakeGitHub::new());
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let polls = Arc::new(FakeSleeper::default());
    let github: Arc<dyn BuiltinCapability> = Arc::new(GitHub::new(Parts {
        transport: fake.clone(),
        secrets: secrets.clone(),
        clock: Arc::new(FakeClock::at(1_763_460_000_000)),
        sleeper: polls.clone(),
        client_id: client_id.into(),
    }));
    let rig = rig_with(vec![github, Arc::new(FakeBuiltin::new(MAIL))], secrets.clone()).await;
    SignIn { rig, fake, secrets, polls }
}

impl SignIn {
    /// Ends the next wait between polls, once it is asked for.
    async fn poll(&self) {
        for _ in 0..10_000 {
            if self.polls.wake() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("no poll waited");
    }

    /// The attempt's status once it is no longer pending.
    async fn ended(&self) -> Value {
        for _ in 0..10_000 {
            let (status, body) = self.rig.ask(Method::Get, PATH, None).await;
            assert_eq!(status, 200);
            if body["state"] != "pending" {
                return body;
            }
            tokio::task::yield_now().await;
        }
        panic!("the sign-in never ended");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_shows_the_code_waits_and_leaves_github_signed_in_and_ready() {
    let s = sign_in("Iv1.fake").await;
    let (status, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(
        (status, row["state"].clone(), row["stateCode"].clone()),
        (200, json!("needs_setup"), json!("secret_missing:token"))
    );

    s.fake.device_answers(vec![json!({ "error": "authorization_pending" }), FakeGitHub::granted()]);
    let (status, started) = s.rig.ask(Method::Post, PATH, None).await;
    assert_eq!(status, 200);
    assert_eq!(started["userCode"], GITHUB_USER_CODE);
    assert_eq!(started["verificationUri"], "https://github.com/login/device");
    assert_eq!(started["expiresAt"], 1_763_460_000_000_i64 + 900_000);
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await, (200, json!({ "state": "pending" })));

    s.poll().await;
    s.poll().await;
    assert_eq!(s.ended().await, json!({ "state": "signed_in", "accountLabel": s.fake.login() }));
    let kept = s.secrets.read("github", "token").await.expect("reads").expect("kept");
    assert_eq!(kept.as_str(), GITHUB_TOKEN);
    let (_, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!((row["state"].clone(), row["accountLabel"].clone()), (json!("ready"), json!(s.fake.login())));
    assert_eq!(s.rig.changes().last().map(String::as_str), Some(r#"{"id":"github","state":"ready"}"#));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_the_user_ends_stops_polling_and_one_out_of_time_says_expired() {
    let s = sign_in("Iv1.fake").await;
    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 200);
    assert_eq!(s.rig.ask(Method::Delete, PATH, None).await, (200, json!({ "ok": true })));
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await.0, 404, "no attempt left");
    for _ in 0..10_000 {
        if s.polls.pending().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(s.polls.pending(), Vec::<i64>::new(), "nothing polls any more");

    s.fake.device_answers(vec![json!({ "error": "expired_token" })]);
    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 200);
    s.poll().await;
    assert_eq!(s.ended().await, json!({ "state": "expired" }));
    assert_eq!(s.secrets.read("github", "token").await.expect("reads"), None);
    let (_, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(row["state"], "needs_setup");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_client_id_the_sign_in_does_not_start_and_says_why() {
    let s = sign_in("").await;
    let (status, body) = s.rig.ask(Method::Post, PATH, None).await;
    assert_eq!(status, 409);
    assert_eq!(body, json!({ "error": "GitHub has no client id to sign in with", "code": "client_id_missing" }));
    assert!(s.fake.calls().is_empty(), "GitHub was never asked");
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_capability_that_signs_in_by_a_code_and_only_this_computer_may_ask() {
    let s = sign_in("Iv1.fake").await;
    for method in [Method::Post, Method::Get, Method::Delete] {
        for id in ["mail", "nothing-here"] {
            let path = format!("/api/capabilities/{id}/sign-in");
            assert_eq!(s.rig.ask(method, &path, None).await.0, 404, "{method:?} {id}");
        }
        assert_eq!(s.rig.ask_as(Caller::UNTRUSTED, method, PATH, None).await.0, 403, "without the ui token");
        let peer = Caller::Peer { device: "AB:CD".into(), human: true };
        assert_eq!(s.rig.ask_as(peer, method, PATH, None).await.0, 403, "a paired computer");
        let phone = Caller::Phone { grant: Tier::Low, mutate: true };
        assert_eq!(s.rig.ask_as(phone, method, PATH, None).await.0, 403, "the phone");
    }
    assert!(s.fake.calls().is_empty());
}
