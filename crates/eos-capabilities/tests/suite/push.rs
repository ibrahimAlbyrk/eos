//! A source whose service pushes (06 G36): adding push keeps a secret per
//! hook and registers the webhook; a push is a hint only when its
//! signature checks out with that hook's secret.

use std::sync::Arc;

use eos_core::capability::{CapabilityCalls, CapabilityRegistry, CapabilitySecrets};
use eos_core::net::hooks::HookUrl;
use eos_core::signals::{PushEvent, PushOutcome, Scope, SourceError};
use eos_testkit::{FakeBuiltin, FakeCapabilitySecrets};
use hmac::{KeyInit, Mac};
use serde_json::json;

use crate::rig::{Setup, rig};

const PUSHING: &str = r#"
id = "github"
name = "GitHub"
version = "1"
summary = "Pull requests."
form = "builtin"
works = "any_mac"

[[secrets]]
name = "token"
label = "GitHub sign-in"

[[actions]]
name = "poll_pull_requests"
summary = "Poll."
class = "read"

[[actions]]
name = "create_webhook"
summary = "Make a webhook."
class = "speak"
recipient = "input:/repo"

[[sources]]
name = "pulls"
item = "github.pull_request"
action = "poll_pull_requests"
push = { verify = "hmac-sha256", signature_header = "X-Hub-Signature-256", delivery_header = "X-GitHub-Delivery" }
"#;

const HOOK: &str = "1234567890abcdef1234567890abcdef";

fn scope() -> Scope {
    Scope::from([("repo".to_owned(), "acme/game".to_owned())])
}

fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = <hmac::Hmac<sha2::Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("any key");
    mac.update(body);
    let bytes = mac.finalize().into_bytes();
    format!("sha256={}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn event(hook: &str, signature: &str, body: &[u8]) -> PushEvent {
    PushEvent {
        hook: hook.into(),
        headers: vec![("x-hub-signature-256".into(), signature.into()), ("x-github-delivery".into(), "d-1".into())],
        body: body.to_vec(),
    }
}

#[tokio::test]
async fn adding_push_keeps_a_secret_per_hook_and_hands_it_only_to_the_webhook_call() {
    let github = Arc::new(FakeBuiltin::new(PUSHING).answering("create_webhook", Ok(json!({ "hookId": 9 }))));
    let rig = rig(Setup {
        builtins: vec![github.clone()],
        secrets: FakeCapabilitySecrets::new().with("github", "token", "gho_x"),
        ..Setup::default()
    })
    .await;
    let source = rig.service.signal_sources().get("github.pulls").expect("the source");
    assert!(source.pushes());
    let hook = HookUrl { id: HOOK.into(), url: format!("https://relay.example/hooks/v1/{}/{HOOK}", "0f".repeat(16)) };
    source.add_push(&scope(), &hook).await.expect("added");

    let [call] = github.calls().try_into().expect("one call");
    assert_eq!(call.action, "create_webhook");
    assert_eq!(call.input, json!({ "repo": "acme/game", "url": hook.url }));
    assert!(call.secrets.contains(&"webhook".to_owned()), "the call has the hook's secret: {:?}", call.secrets);
    let secret = rig.secrets.read("github", &format!("webhook.{HOOK}")).await.expect("read").expect("kept");
    assert_eq!(secret.len(), 64);

    let body = br#"{"action":"opened","number":7}"#;
    let signed = source.accept_push(&scope(), &event(HOOK, &sign(&secret, body), body)).await;
    assert_eq!(signed, Ok(PushOutcome::PollNow { focus: None }));
    let forged = source.accept_push(&scope(), &event(HOOK, &sign("guessed", body), body)).await;
    assert_eq!(forged, Ok(PushOutcome::Refused));
    let changed = source.accept_push(&scope(), &event(HOOK, &sign(&secret, body), b"{}")).await;
    assert_eq!(changed, Ok(PushOutcome::Refused));
    let other =
        source.accept_push(&scope(), &event("ffffffffffffffffffffffffffffffff", &sign(&secret, body), body)).await;
    assert_eq!(other, Ok(PushOutcome::Refused), "a hook with no secret here");
}

#[tokio::test]
async fn a_webhook_the_service_refused_leaves_no_secret_and_a_source_without_push_takes_none() {
    let github = Arc::new(FakeBuiltin::new(PUSHING).answering(
        "create_webhook",
        Err(eos_core::capability::ActionError::Failed { kind: eos_core::capability::FailureKind::Unauthorized }),
    ));
    let rig = rig(Setup {
        builtins: vec![github.clone()],
        secrets: FakeCapabilitySecrets::new().with("github", "token", "gho_x"),
        ..Setup::default()
    })
    .await;
    let source = rig.service.signal_sources().get("github.pulls").expect("the source");
    let hook = HookUrl { id: HOOK.into(), url: "https://relay.example/hooks/v1/x/y".into() };
    assert_eq!(source.add_push(&scope(), &hook).await, Err(SourceError::Unauthorized));
    assert_eq!(rig.secrets.read("github", &format!("webhook.{HOOK}")).await.expect("read"), None);

    let polling = PUSHING.replace(
        "push = { verify = \"hmac-sha256\", signature_header = \"X-Hub-Signature-256\", delivery_header = \"X-GitHub-Delivery\" }\n",
        "",
    );
    let plain = rig_without_push(&polling).await;
    let source = plain.service.signal_sources().get("github.pulls").expect("the source");
    assert!(!source.pushes());
    assert_eq!(source.add_push(&scope(), &hook).await, Err(SourceError::Bad("push")));
    let body = b"{}";
    assert_eq!(source.accept_push(&scope(), &event(HOOK, &sign("x", body), body)).await, Ok(PushOutcome::Refused));
}

#[tokio::test]
async fn only_adding_push_may_register_a_webhook_and_a_refused_call_leaves_the_health_alone() {
    use eos_core::capability::{ActionCaller, ActionError};
    use eos_domain::capability::health::HealthState;

    // The real builtin answers a call without the hook secret as a missing secret.
    let github = Arc::new(
        FakeBuiltin::new(PUSHING)
            .answering("create_webhook", Err(ActionError::NotReady("secret_missing:webhook".into())))
            .answering("poll_pull_requests", Ok(json!({ "items": [] }))),
    );
    let rig = rig(Setup {
        builtins: vec![github.clone()],
        secrets: FakeCapabilitySecrets::new().with("github", "token", "gho_x"),
        ..Setup::default()
    })
    .await;
    let input = json!({ "repo": "acme/game", "url": "https://relay.example/hooks/v1/x/y" });
    let agent = crate::rig::agent_call("github", "create_webhook", input.clone());
    assert_eq!(rig.service.call(agent).await, Err(ActionError::NotGranted));
    for caller in [ActionCaller::Delivery { run_id: "r".into(), delivery_id: "d".into() }, ActionCaller::Source] {
        let mut call = crate::rig::agent_call("github", "create_webhook", input.clone());
        call.caller = caller;
        assert_eq!(rig.service.call(call).await, Err(ActionError::NotGranted));
    }
    assert!(github.calls().is_empty(), "the builtin is never asked");
    let state = rig.service.state("github").await.expect("read").expect("there");
    assert_eq!((state.state, state.code), (HealthState::Ready, None));

    let mut poll = crate::rig::agent_call("github", "poll_pull_requests", json!({}));
    poll.caller = ActionCaller::Source;
    rig.service.call(poll).await.expect("polls still run");
    let described = rig.service.describe("w-1", None).await.expect("described");
    let names: Vec<&str> = described[0].actions.iter().map(|action| action.name.as_str()).collect();
    assert_eq!(names, ["poll_pull_requests"], "an agent is not told of an action it can never call");
}

async fn rig_without_push(manifest: &str) -> crate::rig::Rig {
    rig(Setup { builtins: vec![Arc::new(FakeBuiltin::new(manifest))], ..Setup::default() }).await
}
