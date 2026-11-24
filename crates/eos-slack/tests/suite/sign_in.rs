//! Signing in with PKCE: no secret is sent, the verifier must hash to the
//! challenge on Slack's page, a refusal and a late callback end the attempt;
//! the token pair rotates, and a used refresh token is refused.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_core::capability::{
    ActionError, BrowserCallback, BuiltinCapability, CapabilitySecrets, FailureKind, SignInError,
};
use eos_testkit::{FakeSlack, SLACK_CODE};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::rig::{CHANNEL, NOW, rig, rig_with};

fn query(uri: &str) -> std::collections::HashMap<String, String> {
    let parsed = url::Url::parse(uri).expect("a page");
    parsed.query_pairs().into_owned().collect()
}

#[tokio::test]
async fn connect_and_allow_keeps_the_pair_without_any_secret_of_the_app() {
    let rig = rig_with(FakeSlack::new(), "1234.5678");
    let flow = rig.slack.browser_sign_in().expect("a browser sign-in");
    let code = flow.start().await.expect("starts");
    assert!(code.authorize_uri.starts_with("https://slack.com/oauth/v2/authorize?"));
    let page = query(&code.authorize_uri);
    assert_eq!(page["redirect_uri"], "eos://sign-in/slack");
    assert_eq!(page["code_challenge_method"], "S256");
    assert_eq!(page["state"], code.state.as_str());
    assert!(page["user_scope"].contains("chat:write") && page["user_scope"].contains("search:read"));
    assert!(!page.contains_key("scope"), "no bot scopes");
    assert_eq!(code.verifier.len(), 64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code.verifier.as_bytes()));
    assert_eq!(page["code_challenge"], challenge);
    rig.fake.expect_challenge(&challenge);

    let label = flow.finish(&code, BrowserCallback::Code(Zeroizing::new(SLACK_CODE.into()))).await.expect("signed in");
    assert_eq!(label, "Acme as me");
    let exchange = &rig.fake.calls_of("oauth.v2.access")[0];
    assert!(!exchange.fields.contains_key("client_secret"), "no secret is sent");
    assert_eq!(exchange.fields["client_id"], "1234.5678");
    let kept = rig.secrets.read("slack", "token").await.expect("reads").expect("kept");
    let pair: Value = serde_json::from_str(&kept).expect("json");
    assert_eq!((pair["teamId"].as_str(), pair["userId"].as_str()), (Some("T0ACME001"), Some("U0ME00001")));
    assert_eq!(pair["expiresAt"], json!(NOW + 43_200_000));
}

#[tokio::test]
async fn a_wrong_verifier_a_refusal_a_late_callback_and_no_client_id_end_the_attempt() {
    let rig = rig_with(FakeSlack::new(), "1234.5678");
    let flow = rig.slack.browser_sign_in().expect("a browser sign-in");
    let code = flow.start().await.expect("starts");
    rig.fake.expect_challenge("another-challenge");
    let wrong = flow.finish(&code, BrowserCallback::Code(Zeroizing::new(SLACK_CODE.into()))).await;
    assert_eq!(wrong, Err(SignInError::Failed));
    let denied = flow.finish(&code, BrowserCallback::Refused("access_denied".into())).await;
    assert_eq!(denied, Err(SignInError::Denied));
    rig.clock.advance(11 * 60 * 1000);
    let late = flow.finish(&code, BrowserCallback::Code(Zeroizing::new(SLACK_CODE.into()))).await;
    assert_eq!(late, Err(SignInError::Expired));
    assert!(!rig.secrets.has("slack", "token").await.expect("reads"));
    let none = rig_with(FakeSlack::new(), "  ");
    let refused = none.slack.browser_sign_in().expect("a browser sign-in").start().await;
    assert_eq!(refused.map(drop), Err(SignInError::ClientIdMissing));
}

#[tokio::test]
async fn the_pair_is_refreshed_before_it_ends_kept_first_and_a_used_refresh_token_is_refused() {
    let rig = rig();
    let near_end = rig.fake.token_secret(NOW + 30 * 60 * 1000);
    let ctx = eos_core::capability::ActionContext {
        secrets: [("token".to_owned(), Zeroizing::new(near_end.clone()))].into(),
        settings: json!({}),
        idempotency_key: None,
    };
    rig.call_in("read_conversation", json!({"conversation": CHANNEL}), &ctx).await.expect("reads");
    let kept = rig.secrets.read("slack", "token").await.expect("reads").expect("kept");
    assert!(kept.contains("xoxe-1-fake-1"), "the new pair is kept");
    let history = rig.fake.calls_of("conversations.history");
    assert!(history[0].signed_in, "the new access token is used");
    // A second call with the same old secret uses the pair refreshed here.
    rig.call_in("read_conversation", json!({"conversation": CHANNEL}), &ctx).await.expect("reads");
    assert_eq!(rig.fake.calls_of("oauth.v2.access").len(), 1, "refreshed once");

    // Another copy of Eos still holding the old pair cannot refresh with it again.
    let copy = eos_slack::Slack::new(eos_slack::Parts {
        transport: rig.fake.clone(),
        secrets: std::sync::Arc::new(eos_testkit::FakeCapabilitySecrets::new()),
        clock: rig.clock.clone(),
        sleeper: std::sync::Arc::new(eos_testkit::FakeSleeper::default()),
        ids: std::sync::Arc::new(eos_testkit::SeqIds::new()),
        client_id: "1234.5678".into(),
    });
    let answer = copy.call("check", json!({}), &ctx).await;
    assert_eq!(
        answer,
        Err(ActionError::Failed { kind: FailureKind::Unauthorized }),
        "the used refresh token is refused"
    );
}
