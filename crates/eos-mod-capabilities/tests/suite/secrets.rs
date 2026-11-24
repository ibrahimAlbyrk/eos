//! A capability's secrets: entered only in the native prompt and kept in
//! the secret store, never on the wire or in the log; forgotten on DELETE;
//! never from the phone or a paired computer.

use std::sync::Arc;

use eos_core::capability::CapabilitySecrets;
use eos_core::shell::SecretAsk;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::{FakeBuiltin, FakeCapabilitySecrets, LogCapture};
use serde_json::json;

use crate::rig::{GITHUB, rig_with};

const TYPED: &str = "gho_typed_in_the_prompt_7";
const PATH: &str = "/api/capabilities/github/secrets/token";

#[tokio::test(flavor = "multi_thread")]
async fn a_secret_typed_in_the_prompt_is_kept_and_only_whether_it_was_reaches_the_wire() {
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let rig = rig_with(vec![Arc::new(FakeBuiltin::new(GITHUB))], secrets.clone()).await;
    let (_, row) = rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(row["stateCode"], "secret_missing:token");
    let logs = LogCapture::start();

    rig.prompt.answer(Some(TYPED));
    let (status, answer) = rig.ask(Method::Post, PATH, Some("{}")).await;
    assert_eq!((status, answer.clone()), (200, json!({"stored": true})));
    assert_eq!(
        rig.prompt.asked(),
        [SecretAsk { capability: "GitHub".into(), label: "GitHub sign-in".into(), help: None }]
    );
    let kept = secrets.read("github", "token").await.expect("read");
    assert_eq!(kept.as_deref().map(String::as_str), Some(TYPED));
    let (_, detail) = rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!((detail["state"].as_str(), detail["secrets"][0]["set"].as_bool()), (Some("ready"), Some(true)));
    assert!(!detail.to_string().contains(TYPED));
    assert_eq!(rig.runner.stopped(), ["github"], "code that read the old value stops");

    let (status, answer) = rig.ask(Method::Delete, PATH, None).await;
    assert_eq!((status, answer), (200, json!({"ok": true})));
    assert_eq!(secrets.read("github", "token").await.expect("read"), None);
    let (_, detail) = rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(detail["stateCode"], "secret_missing:token");
    assert!(!logs.text().contains(TYPED), "the value never reaches the log");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_or_empty_prompt_keeps_nothing_and_an_undeclared_secret_is_not_found() {
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let rig = rig_with(vec![Arc::new(FakeBuiltin::new(GITHUB))], secrets.clone()).await;
    rig.prompt.answer(None);
    rig.prompt.answer(Some("   "));
    for _ in 0..2 {
        assert_eq!(rig.ask(Method::Post, PATH, None).await, (200, json!({"stored": false})));
    }
    assert_eq!(secrets.read("github", "token").await.expect("read"), None);

    let refused = ["/api/capabilities/github/secrets/password", "/api/capabilities/nope/secrets/token"];
    for path in refused {
        assert_eq!(rig.ask(Method::Post, path, None).await.0, 404, "{path}");
        assert_eq!(rig.ask(Method::Delete, path, None).await.0, 404, "{path}");
    }
    assert_eq!(rig.prompt.asked().len(), 2, "a prompt is shown only for a declared secret");
}

#[tokio::test(flavor = "multi_thread")]
async fn secrets_are_this_computers_alone() {
    let rig = rig_with(vec![Arc::new(FakeBuiltin::new(GITHUB))], Arc::new(FakeCapabilitySecrets::new())).await;
    let callers = [
        Caller::UNTRUSTED,
        Caller::Phone { grant: Tier::Low, mutate: true },
        Caller::Peer { device: "AB:CD".into(), human: true },
    ];
    for caller in callers {
        for method in [Method::Post, Method::Delete] {
            assert_eq!(rig.ask_as(caller.clone(), method, PATH, None).await.0, 403, "{caller:?} {method:?}");
        }
    }
    assert!(rig.prompt.asked().is_empty());
}
