//! `create_webhook`: one request with the push setup's secret, never one
//! from the input.

use eos_core::capability::{ActionError, BuiltinCapability, FailureKind, WEBHOOK_SECRET};
use serde_json::json;
use zeroize::Zeroizing;

use crate::rig::{REPO, ctx, rig};

const URL: &str = "https://relay.example/hooks/v1/0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f/1234567890abcdef1234567890abcdef";

#[tokio::test]
async fn a_webhook_is_made_for_pull_requests_signed_with_the_setups_secret() {
    let rig = rig();
    let mut ctx = ctx(None);
    ctx.secrets.insert(WEBHOOK_SECRET.to_owned(), Zeroizing::new("s3cret".to_owned()));
    let input = json!({ "repo": REPO, "url": URL, "secret": "from-the-input" });
    let made = rig.github.call("create_webhook", input, &ctx).await.expect("made");
    assert!(made["hookId"].as_i64().is_some_and(|id| id > 0));
    let [hook] = rig.fake.webhooks(REPO).try_into().expect("one webhook");
    assert_eq!(hook["events"], json!(["pull_request"]));
    assert_eq!(hook["config"], json!({ "url": URL, "content_type": "json", "secret": "s3cret", "insecure_ssl": "0" }));
}

#[tokio::test]
async fn without_the_setups_secret_or_admin_rights_nothing_is_made() {
    let rig = rig();
    let refused = rig.call("create_webhook", json!({ "repo": REPO, "url": URL, "secret": "mine" })).await;
    assert_eq!(refused, Err(ActionError::NotReady("secret_missing:webhook".into())));
    assert!(rig.fake.webhooks(REPO).is_empty());

    rig.fake.not_admin(REPO);
    let mut ctx = ctx(None);
    ctx.secrets.insert(WEBHOOK_SECRET.to_owned(), Zeroizing::new("s3cret".to_owned()));
    let refused = rig.github.call("create_webhook", json!({ "repo": REPO, "url": URL }), &ctx).await;
    assert_eq!(refused, Err(ActionError::Failed { kind: FailureKind::NotAllowed }), "not a repository that is gone");
    assert!(rig.fake.webhooks(REPO).is_empty());
}
