//! The health ticker: each capability a routine needs once per simulated
//! hour, at its own minute, and early after a call the service refused for
//! its sign-in.

use std::sync::Arc;
use std::time::Duration;

use eos_core::capability::{ActionCall, ActionCaller, ActionError, CapabilityCalls, FailureKind};
use eos_mod_capabilities::{CHECK_EVERY_MS, TICK_MS};
use eos_runtime::http::Method;
use eos_testkit::{FakeBuiltin, routine_seed};
use serde_json::json;

use crate::rig::{GITHUB, MAIL, Rig, rig};

/// Waits until the loop sleeps again.
async fn sleeping(rig: &Rig) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while rig.sleeper.pending().len() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the ticker sleeps");
}

/// One tick: the clock moves on, the loop wakes, checks what is due and
/// sleeps again.
async fn tick(rig: &Rig) {
    sleeping(rig).await;
    rig.clock.advance(TICK_MS);
    assert!(rig.sleeper.wake());
    tokio::task::yield_now().await;
    sleeping(rig).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn each_capability_a_routine_needs_is_checked_once_an_hour() {
    let (github, mail) = (Arc::new(FakeBuiltin::new(GITHUB)), Arc::new(FakeBuiltin::new(MAIL)));
    let rig = rig(vec![github.clone(), mail.clone()], true).await;
    sleeping(&rig).await;
    assert_eq!(rig.sleeper.pending(), [TICK_MS]);
    // No routine yet: nothing is checked, so the Mail app is never driven.
    for _ in 0..CHECK_EVERY_MS / TICK_MS {
        tick(&rig).await;
    }
    assert_eq!((github.checks(), mail.checks()), (0, 0));
    // PR Review needs GitHub; no routine needs mail.
    assert!(routine_seed::seed(rig.temp.port().as_ref()).await.expect("seeds"));
    for hour in 1..=3 {
        for _ in 0..CHECK_EVERY_MS / TICK_MS {
            tick(&rig).await;
        }
        assert_eq!((github.checks(), mail.checks()), (hour, 0), "after hour {hour}");
    }
    // One switched off is not checked.
    rig.ask(Method::Post, "/api/capabilities/github/disable", None).await;
    for _ in 0..CHECK_EVERY_MS / TICK_MS {
        tick(&rig).await;
    }
    assert_eq!((github.checks(), mail.checks()), (3, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_sign_in_is_checked_at_once() {
    let github = Arc::new(FakeBuiltin::new(GITHUB));
    let rig = rig(vec![github.clone()], true).await;
    sleeping(&rig).await;
    github.answer("list_pull_requests", Err(ActionError::Failed { kind: FailureKind::Unauthorized }));
    let call = ActionCall {
        capability: "github".into(),
        action: "list_pull_requests".into(),
        input: json!({}),
        caller: ActionCaller::Agent { worker_id: "w-1".into() },
        idempotency_key: None,
    };
    assert!(rig.service.call(call).await.is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        while github.checks() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("an early check, without waiting for the hour");
    // The check found the sign-in working again.
    tokio::time::timeout(Duration::from_secs(5), async {
        while rig.changes().last().map(String::as_str) != Some(r#"{"id":"github","state":"ready"}"#) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("back to ready");
    assert_eq!(rig.changes().len(), 3, "{:?}", rig.changes());
}
