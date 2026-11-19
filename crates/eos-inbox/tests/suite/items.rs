//! Opening items: replacement by subject, the notice of a day, the cap of a
//! routine, and withdrawing a deleted routine's items.

use eos_core::store::StoredItem;
use eos_domain::inbox::{Attention, ItemKind, ItemState};
use eos_inbox::{ROUTINE_CAP, TOO_MANY_WAITING, withdraw_routine_in};
use eos_testkit::ControlCall;

use crate::rig::{Rig, new_item};

const HOUR: i64 = 60 * 60 * 1000;

#[tokio::test]
async fn an_item_opens_with_its_kinds_level_and_lifetime_and_is_announced() {
    let rig = Rig::new();
    let mut by_hand = new_item(ItemKind::Draft, None);
    by_hand.by_hand = true;
    let item = rig.open(by_hand).await;
    assert_eq!((item.state, item.rev, item.attention), (ItemState::Open, 1, Attention::Interrupt));
    assert_eq!(item.expires_at, Some(1_000_000 + 14 * 24 * HOUR));
    assert!(item.id.starts_with("nd-"));
    assert_eq!(rig.find(&item.id).await, item);
    let announced = rig.temp.announced.list();
    assert_eq!(announced.len(), 1);
    let (topic, payload) = &announced[0];
    assert_eq!(*topic, "inbox:change");
    let payload: serde_json::Value = serde_json::from_str(payload).expect("JSON");
    assert_eq!(
        payload,
        serde_json::json!({"id": item.id, "kind": "draft", "state": "open", "routineId": "rt-1", "rev": 1, "open": 1})
    );
}

#[tokio::test]
async fn a_newer_item_about_the_same_subject_takes_the_place_of_the_waiting_one() {
    let rig = Rig::new();
    let old = rig.open(new_item(ItemKind::Draft, Some("github:pr:acme/game#482"))).await;
    let other_kind = rig.open(new_item(ItemKind::Question, Some("github:pr:acme/game#482"))).await;
    let other_subject = rig.open(new_item(ItemKind::Draft, Some("github:pr:acme/game#483"))).await;
    let new = rig.open(new_item(ItemKind::Draft, Some("github:pr:acme/game#482"))).await;

    let old = rig.find(&old.id).await;
    assert_eq!((old.state, old.replaced_by.as_deref(), old.rev), (ItemState::Replaced, Some(new.id.as_str()), 2));
    assert_eq!(rig.find(&other_kind.id).await.state, ItemState::Open, "another kind about it stays");
    assert_eq!(rig.find(&other_subject.id).await.state, ItemState::Open);
    assert_eq!(rig.find(&new.id).await.state, ItemState::Open);
}

#[tokio::test]
async fn a_notice_replaces_the_same_days_notice_of_its_kind_only() {
    let rig = Rig::new();
    // 1,000,000 ms is 03:16 in a zone three hours east: the local day began at 21:00 UTC.
    let morning = rig.open(new_item(ItemKind::Notice, Some("over-limit"))).await;
    let unsorted = rig.open(new_item(ItemKind::Notice, Some("unsorted"))).await;
    rig.clock.advance(10 * HOUR);
    let evening = rig.open(new_item(ItemKind::Notice, Some("over-limit"))).await;
    assert_eq!(rig.find(&morning.id).await.state, ItemState::Replaced, "the same local day");
    assert_eq!(rig.find(&unsorted.id).await.state, ItemState::Open, "another kind of notice");

    rig.clock.advance(12 * HOUR);
    let next_day = rig.open(new_item(ItemKind::Notice, Some("over-limit"))).await;
    assert_eq!(rig.find(&evening.id).await.state, ItemState::Open, "yesterday's stays");
    assert_eq!(rig.find(&next_day.id).await.state, ItemState::Open);
}

fn alerts(items: &[StoredItem]) -> Vec<&StoredItem> {
    items.iter().filter(|item| item.kind == ItemKind::RoutineAlert).collect()
}

#[tokio::test]
async fn the_item_after_the_cap_pauses_the_routine_and_opens_one_alert() {
    let rig = Rig::new();
    for _ in 0..ROUTINE_CAP {
        rig.open(new_item(ItemKind::Draft, None)).await;
    }
    assert!(rig.control.calls().is_empty(), "{ROUTINE_CAP} may wait");

    rig.open(new_item(ItemKind::Draft, None)).await;
    rig.open(new_item(ItemKind::Draft, None)).await;
    let pause = ControlCall::Pause { routine_id: "rt-1".into(), reason: TOO_MANY_WAITING.into() };
    assert_eq!(rig.control.calls(), [pause.clone(), pause], "each item past the cap pauses it, in the same job");

    let waiting = rig.temp.port().read(|tx| tx.inbox_items().waiting_of_routine("rt-1")).await.expect("reads");
    assert_eq!(waiting.len(), ROUTINE_CAP + 3, "no result is dropped");
    let alerts = alerts(&waiting);
    assert_eq!(alerts.len(), 1, "one alert");
    let alert = alerts[0];
    assert_eq!((alert.producer.as_str(), alert.subject_key.as_deref()), ("routines", Some(TOO_MANY_WAITING)));
    assert_eq!(alert.title, "26 results wait for you");
    assert_eq!(alert.attention, Attention::Interrupt);
}

#[tokio::test]
async fn a_deleted_routines_waiting_items_are_withdrawn() {
    let rig = Rig::new();
    let open = rig.open(new_item(ItemKind::Draft, None)).await;
    let later = rig.open(new_item(ItemKind::Question, None)).await;
    rig.items.later(&later.id, None).await.expect("put aside");
    let answered = rig.open(new_item(ItemKind::Notice, None)).await;
    let answered = rig.items.discard(&answered.id, answered.rev, "dashboard").await.expect("discarded");
    let mut elsewhere = new_item(ItemKind::Draft, None);
    elsewhere.routine_id = Some("rt-2".into());
    let elsewhere = rig.open(elsewhere).await;

    let now = 2_000_000;
    let withdrawn =
        rig.temp.port().write(move |tx, out| withdraw_routine_in(tx, out, now, "rt-1")).await.expect("withdraws");
    assert_eq!(withdrawn, 2);
    for id in [&open.id, &later.id] {
        let item = rig.find(id).await;
        assert_eq!((item.state, item.updated_at), (ItemState::Withdrawn, now));
    }
    assert_eq!(rig.find(&answered.id).await.state, ItemState::Answered, "an answer stays");
    assert_eq!(rig.find(&elsewhere.id).await.state, ItemState::Open, "another routine's stays");
}
