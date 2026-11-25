//! A capability that breaks pauses the routines that need it with one item
//! per capability; once it works again only those resume and the item goes.

use std::sync::Arc;
use std::time::Duration;

use eos_domain::capability::health::Event;
use eos_runtime::http::Method;
use eos_testkit::{ControlCall, FakeBuiltin, FakeRoutineControl};
use serde_json::Value;

use crate::rig::{GITHUB, Rig, notes, rig_breaking};

const OPEN: &str = "SELECT COUNT(*) FROM inbox_items WHERE kind = 'capability_attention' AND state = 'open'";

/// Waits until `done` holds: the watch settles after the change commits.
async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never: {what}");
}

fn paused(control: &FakeRoutineControl, reason: &str) -> usize {
    let call = |call: &ControlCall| matches!(call, ControlCall::Pause { reason: r, .. } if r == reason);
    control.calls().iter().filter(|c| call(c)).count()
}

fn resumed(control: &FakeRoutineControl, reason: &str) -> usize {
    control.calls().iter().filter(|call| **call == ControlCall::ResumePaused(reason.to_owned())).count()
}

fn open_payload(rig: &Rig) -> Value {
    let text = rig.temp.text("SELECT payload FROM inbox_items WHERE kind = 'capability_attention' AND state = 'open'");
    serde_json::from_str(&text).expect("a payload")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_sign_in_pauses_its_routines_with_one_item_until_it_works_again() {
    let builtin = Arc::new(FakeBuiltin::new(GITHUB));
    let control = Arc::new(FakeRoutineControl::new().using("github", &["rt-1", "rt-2"]));
    let rig = rig_breaking(vec![builtin.clone()], control.clone()).await;
    assert_eq!(resumed(&control, "capability:github"), 1, "settled at start: it works");

    builtin.set_health(Event::Unauthorized);
    rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    until("both routines paused", || paused(&control, "capability:github") == 2).await;
    until("one item", || rig.temp.count(OPEN) == 1).await;
    let payload = open_payload(&rig);
    assert_eq!(payload["state"], "needs_sign_in");
    assert_eq!(payload["stateCode"], "http_401");
    assert_eq!(payload["repair"], false);
    let title = rig.temp.text("SELECT title FROM inbox_items WHERE kind = 'capability_attention'");
    assert_eq!(title, "GitHub needs you to sign in again");

    // Still signed out at the next check: the same item waits, no second one.
    rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    rig.service.disable("github").await.expect("off");
    until("the item went with the switch", || rig.temp.count(OPEN) == 0).await;
    rig.service.enable("github").await.expect("on");
    builtin.set_health(Event::Passed);
    rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    until("resumed", || resumed(&control, "capability:github") >= 2).await;
    assert_eq!(rig.temp.count(OPEN), 0);
    assert_eq!(
        rig.temp.count("SELECT COUNT(*) FROM inbox_items WHERE state = 'withdrawn'"),
        1,
        "one item was opened and withdrawn"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_broken_package_offers_repair_and_the_version_before() {
    let control = Arc::new(FakeRoutineControl::new().using("notes-db", &["rt-1"]));
    let rig = rig_breaking(Vec::new(), control.clone()).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    rig.clock.advance(1000);
    rig.install(&notes("1.1.0"), "h-2").await;
    rig.files.tamper("notes-db", "1.1.0", "h-other");
    rig.ask(Method::Post, "/api/capabilities/notes-db/check", None).await;
    until("one item", || rig.temp.count(OPEN) == 1).await;
    let payload = open_payload(&rig);
    assert_eq!((payload["state"].as_str(), payload["stateCode"].as_str()), (Some("broken"), Some("hash_mismatch")));
    assert_eq!((payload["repair"].as_bool(), payload["goBack"].as_str()), (Some(true), Some("1.0.0")));
    assert!(paused(&control, "capability:notes-db") >= 1);

    // The installs settled too: only a resume after the rollback counts.
    let before = resumed(&control, "capability:notes-db");
    let (status, _) =
        rig.ask(Method::Post, "/api/capabilities/notes-db/rollback", Some(r#"{"version": "1.0.0"}"#)).await;
    assert_eq!(status, 200);
    until("resumed once it works", || resumed(&control, "capability:notes-db") > before).await;
    assert_eq!(rig.temp.count(OPEN), 0);

    // Removed: its routines stay paused, and there is nothing to ask.
    let before = paused(&control, "capability:notes-db");
    rig.ask(Method::Delete, "/api/capabilities/notes-db", None).await;
    until("paused again", || paused(&control, "capability:notes-db") > before).await;
    assert_eq!(rig.temp.count(OPEN), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_that_needs_two_broken_capabilities_stays_paused_until_both_work() {
    let builtin = Arc::new(FakeBuiltin::new(GITHUB));
    let control = Arc::new(FakeRoutineControl::new().using("github", &["rt-1"]).using("notes-db", &["rt-1"]));
    let rig = rig_breaking(vec![builtin.clone()], control.clone()).await;
    rig.temp.exec(
        "INSERT INTO routines (id, slug, name, kind, state, paused_reason, origin, created_at, updated_at, changed_at) \
         VALUES ('rt-1', 'pr-review', 'PR Review', 'standing', 'paused', 'capability:github', 'hand', 1, 1, 1)",
    );
    rig.install(&notes("1.0.0"), "h-1").await;
    rig.service.disable("notes-db").await.expect("off");
    builtin.set_health(Event::Unauthorized);
    rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    until("paused for github", || paused(&control, "capability:github") >= 1).await;

    builtin.set_health(Event::Passed);
    rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    let resume = ControlCall::Resume { routine_id: "rt-1".into(), reason: "capability:github".into() };
    let pause = ControlCall::Pause { routine_id: "rt-1".into(), reason: "capability:notes-db".into() };
    // The call after the routine's own Resume, once one was made.
    let after_resume = || {
        let calls = control.calls();
        calls.iter().position(|call| *call == resume).and_then(|at| calls.get(at + 1).cloned())
    };
    until("github works and its routine is handed on", || after_resume().is_some()).await;
    assert_eq!(after_resume(), Some(pause), "it waits for notes-db now: {:?}", control.calls());
}
