//! The manifest passes the built-in check; Slack's error codes and limits
//! become the errors Eos acts on; health reads `auth.test` and the scopes.

use eos_contracts::ActionClass;
use eos_core::capability::{ActionError, BuiltinCapability, FailureKind};
use eos_domain::capability::check::check_builtin;
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::routine::trust::untrusted_facts;
use eos_testkit::FakeSlack;
use serde_json::json;

use crate::rig::{CHANNEL, rig, rig_with};

#[tokio::test]
async fn the_manifest_passes_the_built_in_check_and_marks_what_people_wrote() {
    let rig = rig();
    let manifest = rig.slack.manifest();
    assert_eq!(check_builtin(manifest), []);
    let untrusted = untrusted_facts(manifest, "messages");
    assert_eq!(
        untrusted.into_iter().collect::<Vec<_>>(),
        ["data", "title"],
        "who wrote a message is Slack's fact, not theirs"
    );
    let class = |name: &str| manifest.action(name).map(|action| action.class);
    assert_eq!(class("post_message"), Some(ActionClass::Speak));
    assert_eq!(class("tell_me"), Some(ActionClass::TellUser));
    assert_eq!(class("read_conversation"), Some(ActionClass::Read));
}

#[tokio::test]
async fn every_error_code_becomes_its_action_error() {
    let cases = [
        ("invalid_auth", ActionError::Failed { kind: FailureKind::Unauthorized }),
        ("token_revoked", ActionError::Failed { kind: FailureKind::Unauthorized }),
        ("account_inactive", ActionError::Failed { kind: FailureKind::Unauthorized }),
        ("missing_scope", ActionError::NotReady("scope_missing".into())),
        ("ratelimited", ActionError::RateLimited { retry_after_s: 60 }),
        ("channel_not_found", ActionError::Failed { kind: FailureKind::Gone }),
        ("is_archived", ActionError::Failed { kind: FailureKind::Gone }),
        ("not_in_channel", ActionError::Failed { kind: FailureKind::NotAllowed }),
        ("restricted_action", ActionError::Failed { kind: FailureKind::NotAllowed }),
        ("invalid_arguments", ActionError::Failed { kind: FailureKind::Validation }),
        ("internal_error", ActionError::Failed { kind: FailureKind::Service }),
        ("service_unavailable", ActionError::Failed { kind: FailureKind::Service }),
    ];
    for (code, expected) in cases {
        let rig = rig();
        rig.fake.refuse("conversations.history", code);
        let answer = rig.call("read_conversation", json!({"conversation": CHANNEL})).await;
        assert_eq!(answer, Err(expected), "{code}");
    }
}

#[tokio::test]
async fn a_429_waits_out_its_retry_after_without_calling_again() {
    let rig = rig();
    rig.fake.limit("search.messages", 30);
    let limited = rig.call("search_messages", json!({"q": "deploy"})).await;
    assert_eq!(limited, Err(ActionError::RateLimited { retry_after_s: 30 }));
    rig.fake.unlimit("search.messages");
    let held = rig.call("search_messages", json!({"q": "deploy"})).await;
    assert_eq!(held, Err(ActionError::RateLimited { retry_after_s: 30 }), "held until Retry-After passed");
    assert_eq!(rig.fake.calls_of("search.messages").len(), 1);
    rig.clock.advance(31_000);
    assert!(rig.call("search_messages", json!({"q": "deploy"})).await.is_ok());
}

#[tokio::test]
async fn health_needs_a_client_id_a_sign_in_and_every_scope() {
    let none = rig_with(FakeSlack::new().signed_in(), "");
    assert_eq!(none.slack.health(&none.ctx(None)).await, Event::Missing(StateCode::ClientIdMissing));
    let rig = rig();
    assert_eq!(rig.slack.health(&rig.ctx(None)).await, Event::Passed);
    rig.fake.scopes("chat:write,channels:history");
    assert_eq!(rig.slack.health(&rig.ctx(None)).await, Event::ScopeMissing);
    let empty =
        eos_core::capability::ActionContext { secrets: Default::default(), settings: json!({}), idempotency_key: None };
    assert_eq!(rig.slack.health(&empty).await, Event::Missing(StateCode::SecretMissing("token".into())));
}

#[test]
fn the_app_manifest_asks_for_what_the_sign_in_asks_for() {
    let text = include_str!("../../../../fixtures/capabilities/slack/app-manifest.json");
    let app: serde_json::Value = serde_json::from_str(text).expect("the app manifest is JSON");
    assert_eq!(app["oauth_config"]["redirect_urls"], json!([eos_slack::REDIRECT]));
    assert_eq!(app["oauth_config"]["scopes"]["user"], json!(eos_slack::USER_SCOPES));
    assert!(app["oauth_config"]["scopes"].get("bot").is_none(), "a desktop sign-in asks no bot scopes");
    assert_eq!(
        (&app["oauth_config"]["pkce_enabled"], &app["settings"]["token_rotation_enabled"]),
        (&json!(true), &json!(true))
    );
}
