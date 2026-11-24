//! Signing in to Slack in the browser, with the Slack capability itself on
//! `FakeSlack`: Connect answers Slack's page and no code to type; a link back
//! whose state matches no attempt is dropped; Allow leaves Slack signed in
//! and ready; a refusal says denied; without a client id it says why.

use std::sync::Arc;

use eos_core::capability::{BuiltinCapability, CapabilitySecrets};
use eos_runtime::http::Method;
use eos_slack::{Parts, Slack};
use eos_testkit::{FakeCapabilitySecrets, FakeClock, FakeSlack, FakeSleeper, SLACK_CODE, SeqIds};
use serde_json::{Value, json};

use crate::rig::{Rig, rig_with};

const PATH: &str = "/api/capabilities/slack/sign-in";

async fn slack(client_id: &str) -> (Rig, Arc<FakeSlack>, Arc<FakeCapabilitySecrets>) {
    let fake = Arc::new(FakeSlack::new());
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let slack: Arc<dyn BuiltinCapability> = Arc::new(Slack::new(Parts {
        transport: fake.clone(),
        secrets: secrets.clone(),
        clock: Arc::new(FakeClock::new()),
        sleeper: Arc::new(FakeSleeper::default()),
        ids: Arc::new(SeqIds::new()),
        client_id: client_id.into(),
    }));
    (rig_with(vec![slack], secrets.clone()).await, fake, secrets)
}

fn page_field(uri: &str, name: &str) -> String {
    let page = url::Url::parse(uri).expect("a page");
    page.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).expect("the field")
}

async fn ended(rig: &Rig) -> Value {
    for _ in 0..10_000 {
        let (_, body) = rig.ask(Method::Get, PATH, None).await;
        if body["state"] != "pending" {
            return body;
        }
        tokio::task::yield_now().await;
    }
    panic!("the sign-in never ended");
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_and_allow_leave_slack_signed_in_and_ready_with_no_code_to_type() {
    let (rig, fake, secrets) = slack("1234.5678").await;
    let (status, started) = rig.ask(Method::Post, PATH, None).await;
    assert_eq!(status, 200, "{started}");
    assert!(started.get("userCode").is_none(), "a browser sign-in has no code to type");
    let page = started["verificationUri"].as_str().expect("Slack's page").to_owned();
    assert!(page.starts_with("https://slack.com/oauth/v2/authorize?"));
    fake.expect_challenge(&page_field(&page, "code_challenge"));
    let state = page_field(&page, "state");

    assert!(!rig.links.open(&format!("eos://sign-in/slack?code={SLACK_CODE}&state=forged")), "a stranger's link");
    assert!(!rig.links.open("eos://pair/abc"), "not a sign-in's link");
    assert_eq!(rig.ask(Method::Get, PATH, None).await.1, json!({"state": "pending"}));
    assert!(rig.links.open(&format!("eos://sign-in/slack?code={SLACK_CODE}&state={state}")));
    assert_eq!(ended(&rig).await, json!({"state": "signed_in", "accountLabel": "Acme as me"}));
    assert!(secrets.has("slack", "token").await.expect("reads"));
    let (_, row) = rig.ask(Method::Get, "/api/capabilities/slack", None).await;
    assert_eq!((row["state"].clone(), row["accountLabel"].clone()), (json!("ready"), json!("Acme as me")));
    assert!(!rig.links.open(&format!("eos://sign-in/slack?code={SLACK_CODE}&state={state}")), "a link works once");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_in_the_browser_says_denied_and_no_client_id_says_why() {
    let (rig, _, _) = slack("1234.5678").await;
    let (_, started) = rig.ask(Method::Post, PATH, None).await;
    let state = page_field(started["verificationUri"].as_str().expect("a page"), "state");
    assert!(rig.links.open(&format!("eos://sign-in/slack?error=access_denied&state={state}")));
    assert_eq!(ended(&rig).await, json!({"state": "denied"}));

    let (none, _, _) = slack("").await;
    let (status, refused) = none.ask(Method::Post, PATH, None).await;
    assert_eq!(status, 409);
    assert_eq!(refused, json!({"error": "Slack has no client id to sign in with", "code": "client_id_missing"}));
}
