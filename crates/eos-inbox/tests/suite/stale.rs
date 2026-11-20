//! A subject that moved on flags its drafts stale by how many newer
//! versions came in, and a stale draft is sent only on a second confirm; a
//! subject that closed expires its items, ends the draft's run and stops
//! its queued sends.

use eos_contracts::SignalSubject;
use eos_core::Clock;
use eos_core::routine::GateDecision;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use eos_inbox::Error;
use eos_testkit::OutcomeCall;
use serde_json::json;

use crate::delivery::Sender;
use crate::gate::{Gated, input};
use crate::rig::new_item;

const SUBJECT: &str = "github:pr:acme/game#482";

fn moved(version: &str) -> SignalSubject {
    SignalSubject { subject_key: SUBJECT.into(), version: Some(version.into()), closed: false }
}

/// Run `rn-1`'s review held as a draft, made on version `abc`.
async fn held(gated: &Gated) -> String {
    let mut made = input("draft");
    made.item_facts["version"] = json!("abc");
    match gated.apply(made).await {
        GateDecision::Held { item_id } => item_id,
        other => panic!("not held: {other:?}"),
    }
}

#[tokio::test]
async fn a_new_version_flags_the_draft_stale_by_how_many_came_in() {
    let gated = Gated::new();
    let id = held(&gated).await;
    let items = &gated.rig.items;

    assert_eq!(items.subject(moved("abc")).await.expect("acted"), 0, "the draft's own version");
    assert_eq!(gated.rig.find(&id).await.stale_at, None);

    items.subject(moved("def")).await.expect("acted");
    let item = gated.rig.find(&id).await;
    let now = gated.rig.clock.now_ms();
    assert_eq!((item.stale_at, item.stale_reason.as_deref(), item.rev), (Some(now), Some("1 new commit"), 2));

    assert_eq!(items.subject(moved("def")).await.expect("acted"), 0, "a version heard twice counts once");
    items.subject(moved("ghi")).await.expect("acted");
    let item = gated.rig.find(&id).await;
    assert_eq!((item.stale_reason.as_deref(), item.state), (Some("2 new commits"), ItemState::Open));
}

#[tokio::test]
async fn a_stale_draft_is_sent_only_on_a_second_confirm() {
    let gated = Gated::new();
    let id = held(&gated).await;
    gated.rig.items.subject(moved("def")).await.expect("acted");
    let rev = gated.rig.find(&id).await.rev;

    match gated.rig.items.send(&id, rev, None, "dashboard", false).await {
        Err(Error::Stale { reason }) => assert_eq!(reason, "1 new commit"),
        other => panic!("{other:?}"),
    }
    assert_eq!(gated.rows(), 0);
    let rows = gated.rig.items.send(&id, rev, None, "dashboard", true).await.expect("sent anyway");
    assert_eq!((rows.len(), rows[0].state.as_str()), (1, "queued"));
}

#[tokio::test]
async fn a_closed_subject_expires_its_items_ends_the_drafts_run_and_stops_its_sends() {
    let sender = Sender::new();
    let draft = sender.rig.open(new_item(ItemKind::Draft, Some(SUBJECT))).await;
    let mut question = new_item(ItemKind::Question, Some(SUBJECT));
    question.run_id = Some("rn-9".into());
    let question = sender.rig.open(question).await;
    sender.queue("dl-1", "github", "pr", "queued", "approved", sender.rig.clock.now_ms()).await;
    sender.rig.temp.exec("UPDATE runs SET state = 'waiting_for_user' WHERE id = 'rn-1'");

    let closed = SignalSubject { subject_key: SUBJECT.into(), version: None, closed: true };
    assert_eq!(sender.rig.items.subject(closed).await.expect("acted"), 2);
    for id in [&draft.id, &question.id] {
        let item = sender.rig.find(id).await;
        assert_eq!((item.state, item.stale_reason.as_deref()), (ItemState::Expired, Some("subject_closed")));
    }
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("stopped", Some("subject_closed")));
    let ended = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Expired };
    assert_eq!(sender.rig.outcomes.calls(), [ended]);
    let rows = sender.rig.temp.count("SELECT COUNT(*) FROM inbox_outcomes WHERE outcome = 'expired'");
    assert_eq!(rows, 1, "the question ends no run");
    sender.pass().await;
    assert!(sender.sent().is_empty());
}

/// Run `run`'s review of the pull request at `version`, keyed as a source
/// keys a run's item: with its version.
fn at_version(run: &str, version: &str) -> eos_core::routine::GateInput {
    let mut made = input("draft");
    made.run_id = run.into();
    made.subject_key = Some(format!("{SUBJECT}@{version}"));
    made.item_facts["key"] = json!(format!("{SUBJECT}@{version}"));
    made.item_facts["version"] = json!(version);
    made
}

#[tokio::test]
async fn a_draft_of_an_item_keyed_with_its_version_is_found_by_its_subject() {
    let gated = Gated::new();
    let first = match gated.apply(at_version("rn-1", "abc")).await {
        GateDecision::Held { item_id } => item_id,
        other => panic!("not held: {other:?}"),
    };
    assert_eq!(gated.rig.find(&first).await.subject_key.as_deref(), Some(SUBJECT));
    gated.rig.items.subject(moved("def")).await.expect("acted");
    assert_eq!(gated.rig.find(&first).await.stale_reason.as_deref(), Some("1 new commit"));

    gated.rig.temp.exec("UPDATE runs SET state = 'waiting_for_user' WHERE id = 'rn-1'");
    gated.rig.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-2', 'rt-1', 'standing', 'trigger', '{}', 'checking', 0, 'mac-1', 2, 2)",
    );
    let second = match gated.apply(at_version("rn-2", "def")).await {
        GateDecision::Held { item_id } => item_id,
        other => panic!("not held: {other:?}"),
    };
    let old = gated.rig.find(&first).await;
    assert_eq!((old.state, old.replaced_by), (ItemState::Replaced, Some(second)));
    let ended = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Replaced };
    assert_eq!(gated.rig.outcomes.calls(), [ended]);
}

#[tokio::test]
async fn a_send_held_again_is_about_the_item_without_its_version_and_keeps_that_version() {
    let sender = Sender::new();
    sender.rig.temp.exec(&format!(
        "UPDATE runs SET item_key = '{SUBJECT}@abc', input = '{{\"item\":{{\"kind\":\"github.pull_request\",\
         \"key\":\"{SUBJECT}@abc\",\"version\":\"abc\",\"untrusted\":true}}}}' WHERE id = 'rn-1'"
    ));
    sender.queue("dl-1", "github", "pr", "queued", "approved", sender.rig.clock.now_ms()).await;
    sender.channels.stale("new commits");
    sender.pass().await;
    let items = sender.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    let draft = items.iter().find(|item| item.kind == ItemKind::Draft).expect("held again");
    assert_eq!(draft.subject_key.as_deref(), Some(SUBJECT));
    assert_eq!(sender.rig.items.subject(moved("abc")).await.expect("acted"), 0, "the version it was made on");
    assert_eq!(sender.rig.items.subject(moved("def")).await.expect("acted"), 1);
}
