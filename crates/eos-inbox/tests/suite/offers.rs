//! The freedom a routine earns: ten sends in a row as Eos made them open one
//! offer; Accept raises the routine after the answer, Not now counts ten
//! again, an edit resets the streak; a send held again after an edited send
//! stays edited; a hand change of Freedom lifts Never, and a new head that
//! changes the work resets the streak.

use eos_contracts::{ActionClass, InboxAnswer, OfferChoice, Rung};
use eos_core::Clock;
use eos_core::routine::Confirmed;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::{HeadChange, head_changed_in};
use eos_testkit::ControlCall;
use serde_json::json;

use crate::gate::review_traits;
use crate::rig::pull_requests;
use crate::send::Held;

/// What the user confirmed of `rt-1`: its pull request, at rung `rung`.
fn at_rung(rung: &str) -> Confirmed {
    Confirmed { freedom: serde_json::from_value(json!({ "rung": rung })).expect("a freedom"), ..pull_requests() }
}

/// More outcomes of `rt-1`, oldest first, each after the ones before.
fn earlier(held: &Held, outcomes: &[&str]) {
    for outcome in outcomes {
        held.rig.temp.exec(&format!(
            "INSERT INTO inbox_outcomes (routine_id, run_id, outcome, rung, at) \
             VALUES ('rt-1', 'rn-old', '{outcome}', 'ask', (SELECT COUNT(*) FROM inbox_outcomes) - 1000)"
        ));
    }
}

async fn send_unedited(held: &Held) {
    held.rig.items.send(&held.item_id, 1, None, "dashboard", false).await.expect("sent");
    held.deliver().await;
}

/// The offer that waits.
async fn offer_id(held: &Held) -> String {
    let waiting = held.rig.temp.port().read(|tx| tx.inbox_items().waiting(50)).await.expect("reads");
    waiting.into_iter().find(|item| item.kind == ItemKind::FreedomOffer).expect("an offer").id
}

fn offer_items(held: &Held) -> i64 {
    held.rig.temp.count("SELECT COUNT(*) FROM inbox_items WHERE kind = 'freedom_offer'")
}

#[tokio::test]
async fn the_tenth_unedited_send_offers_the_next_rung_and_accept_raises_after_the_answer() {
    let held = Held::through(at_rung("ask"), review_traits(ActionClass::Speak)).await;
    earlier(&held, &["sent_edited", "sent_unedited", "sent_unedited", "sent_unedited", "expired"]);
    earlier(&held, &["sent_unedited"; 6]);
    assert_eq!(held.rig.items.freedom("rt-1").await.expect("read").streak, 9);
    send_unedited(&held).await;

    let offer = offer_id(&held).await;
    let item = held.rig.find(&offer).await;
    assert_eq!((item.kind, item.state, item.producer.as_str()), (ItemKind::FreedomOffer, ItemState::Open, "inbox"));
    let view = held.rig.items.freedom("rt-1").await.expect("read");
    assert_eq!(
        (view.rung, view.offer.as_str(), view.offer_item_id.as_deref()),
        (Rung::Ask, "offered", Some(offer.as_str()))
    );

    let accept = InboxAnswer::FreedomOffer { choice: OfferChoice::Accept };
    held.rig.items.answer(&offer, 1, &accept, "dashboard").await.expect("answered");
    let raise = ControlCall::Raise { routine_id: "rt-1".into(), rung: Rung::Draft };
    assert_eq!(held.rig.control.calls().last(), Some(&raise));
    let view = held.rig.items.freedom("rt-1").await.expect("read");
    assert_eq!((view.streak, view.offer.as_str()), (0, "none"), "the streak counts again from the answer");
    assert!(held.rig.find(&offer).await.consumed_at.is_some());
}

#[tokio::test]
async fn not_now_waits_for_ten_more_and_an_edit_resets_the_streak() {
    let held = Held::through(at_rung("ask"), review_traits(ActionClass::Speak)).await;
    earlier(&held, &["sent_unedited"; 9]);
    send_unedited(&held).await;
    let offer = offer_id(&held).await;
    let not_now = InboxAnswer::FreedomOffer { choice: OfferChoice::NotNow };
    held.rig.items.answer(&offer, 1, &not_now, "phone").await.expect("answered");
    assert!(!held.rig.control.calls().iter().any(|call| matches!(call, ControlCall::Raise { .. })));
    let view = held.rig.items.freedom("rt-1").await.expect("read");
    assert_eq!((view.streak, view.offer.as_str()), (0, "declined"));

    for outcome in ["sent_unedited", "sent_unedited", "sent_edited", "sent_unedited"] {
        held.rig.temp.exec(&format!(
            "INSERT INTO inbox_outcomes (routine_id, run_id, outcome, rung, at) \
             VALUES ('rt-1', 'rn-new', '{outcome}', 'ask', 2000000 + (SELECT COUNT(*) FROM inbox_outcomes))"
        ));
    }
    assert_eq!(held.rig.items.freedom("rt-1").await.expect("read").streak, 1, "an edit ended it");
    assert_eq!(offer_items(&held), 1);
}

#[tokio::test]
async fn never_ends_offers_and_no_rung_that_sends_alone_is_offered_while_locked() {
    let held = Held::through(at_rung("ask"), review_traits(ActionClass::Speak)).await;
    held.rig.temp.exec("INSERT INTO inbox_offers (routine_id, state, updated_at) VALUES ('rt-1', 'never', 1)");
    earlier(&held, &["sent_unedited"; 12]);
    send_unedited(&held).await;
    assert_eq!(offer_items(&held), 0);

    let draft = Held::new().await;
    earlier(&draft, &["sent_unedited"; 12]);
    send_unedited(&draft).await;
    let expected = i64::from(!eos_domain::freedom::AUTOMATIC_RUNGS_LOCKED);
    assert_eq!(offer_items(&draft), expected);
}

/// `rt-1` kept a new head at `rung` that differs from the one before by
/// `change`.
async fn head_changed(held: &Held, rung: Rung, change: HeadChange) {
    let now = held.rig.clock.now_ms();
    held.rig
        .temp
        .port()
        .write(move |tx, out| head_changed_in(tx, out, "rt-1", rung, change, now))
        .await
        .expect("written");
}

#[tokio::test]
async fn a_hand_change_of_freedom_lifts_never_and_a_change_of_the_work_resets_the_streak() {
    let held = Held::through(at_rung("ask"), review_traits(ActionClass::Speak)).await;
    held.rig.temp.exec("INSERT INTO inbox_offers (routine_id, state, updated_at) VALUES ('rt-1', 'never', 1)");
    earlier(&held, &["sent_unedited"; 4]);
    let neither = HeadChange { freedom_by_hand: false, work: false };
    head_changed(&held, Rung::Ask, neither).await;
    let view = held.rig.items.freedom("rt-1").await.expect("read");
    assert_eq!((view.streak, view.offer.as_str()), (4, "never"), "an unrelated change leaves both");

    head_changed(&held, Rung::Ask, HeadChange { freedom_by_hand: true, work: false }).await;
    let view = held.rig.items.freedom("rt-1").await.expect("read");
    assert_eq!((view.streak, view.offer.as_str()), (4, "none"), "the hand change lifts never only");

    head_changed(&held, Rung::Ask, HeadChange { freedom_by_hand: false, work: true }).await;
    assert_eq!(held.rig.items.freedom("rt-1").await.expect("read").streak, 0);
    earlier(&held, &["sent_unedited"; 2]);
    assert_eq!(held.rig.items.freedom("rt-1").await.expect("read").streak, 2, "it counts from the new head");
}
