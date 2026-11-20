//! The sweeper: a draft expires after 14 days and ends its run, a run's
//! start is answered `expired` by the system, an item put off comes back
//! at its time, and items that ended 90 days ago are deleted in pages.

use eos_core::Clock;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use eos_testkit::OutcomeCall;

use crate::rig::{Rig, new_item};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[tokio::test]
async fn a_draft_expires_after_fourteen_days_and_ends_its_run() {
    let rig = Rig::new();
    rig.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-1', 'rt-1', 'standing', 'hand', '{}', 'waiting_for_user', 0, 'mac-1', 1, 1)",
    );
    let draft = rig.open(new_item(ItemKind::Draft, None)).await;
    let made = rig.clock.now_ms();
    assert_eq!(rig.items.sweep().await.expect("swept"), Some(made + 14 * DAY_MS), "it wakes when the draft expires");
    rig.clock.set(made + 14 * DAY_MS);
    assert_eq!(rig.items.sweep().await.expect("swept"), None);
    assert_eq!(rig.find(&draft.id).await.state, ItemState::Expired);
    let ended = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Expired };
    assert_eq!(rig.outcomes.calls(), [ended]);
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM inbox_outcomes WHERE outcome = 'expired'"), 1);
}

#[tokio::test]
async fn a_runs_start_that_waited_three_days_is_answered_expired_for_its_run() {
    let rig = Rig::new();
    let start = rig.open(new_item(ItemKind::RunStart, None)).await;
    rig.clock.advance(3 * DAY_MS);
    rig.items.sweep().await.expect("swept");
    let item = rig.find(&start.id).await;
    assert_eq!((item.state, item.answered_by.as_deref()), (ItemState::Answered, Some("system")));
    assert_eq!(item.answer.as_deref(), Some(r#"{"expired":true}"#));
    let handed = rig.items.unconsumed("routines").await.expect("reads");
    assert_eq!(handed.iter().map(|item| item.id.clone()).collect::<Vec<_>>(), [start.id]);
}

#[tokio::test]
async fn an_item_put_off_comes_back_at_its_time() {
    let rig = Rig::new();
    let question = rig.open(new_item(ItemKind::Question, None)).await;
    let until = rig.clock.now_ms() + 60_000;
    rig.items.later(&question.id, Some(until)).await.expect("put off");
    assert_eq!(rig.items.sweep().await.expect("swept"), Some(until));
    rig.clock.set(until);
    rig.items.sweep().await.expect("swept");
    let item = rig.find(&question.id).await;
    assert_eq!((item.state, item.later_until), (ItemState::Open, None));
}

#[tokio::test]
async fn items_that_ended_ninety_days_ago_are_deleted_in_pages() {
    let rig = Rig::new();
    let now = rig.clock.now_ms();
    let old = now - 91 * DAY_MS;
    rig.temp.exec(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) \
         INSERT INTO inbox_items (id, kind, state, producer, title, summary, payload, rev, attention, created_at, \
         updated_at) SELECT 'nd-old-' || i, 'notice', 'answered', 'routines', 't', 's', '{{}}', 2, 'digest', {old}, \
         {old} FROM n"
    ));
    rig.temp.exec(&format!(
        "INSERT INTO inbox_items (id, kind, state, producer, title, summary, payload, rev, attention, created_at, \
         updated_at) VALUES ('nd-recent', 'notice', 'expired', 'routines', 't', 's', '{{}}', 2, 'digest', {now}, {now})"
    ));
    let open = rig.open(new_item(ItemKind::Question, None)).await;
    rig.temp.exec(&format!("UPDATE inbox_items SET created_at = {old}, updated_at = {old} WHERE id = '{}'", open.id));
    rig.items.sweep().await.expect("swept");
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM inbox_items WHERE id LIKE 'nd-old-%'"), 0, "every page is gone");
    assert_eq!(rig.find("nd-recent").await.state, ItemState::Expired, "a recent ended item stays");
    assert_eq!(rig.find(&open.id).await.state, ItemState::Open, "a waiting one stays");
}
