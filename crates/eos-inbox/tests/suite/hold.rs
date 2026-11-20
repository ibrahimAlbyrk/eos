//! A send waits out its hold where its channel cannot take it back, and
//! Stop inside it opens the draft again; a send through a channel that can
//! undo goes at once. An automatic send a day old is held as a draft, and
//! one that waited for its capability goes once its channel is back.

use eos_contracts::ActionClass;
use eos_core::Clock;
use eos_core::delivery::{ChannelTraits, Idempotency, Undo};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use eos_inbox::Error;
use eos_testkit::OutcomeCall;

use crate::delivery::Sender;
use crate::rig::pull_requests;
use crate::send::Held;

/// A channel that cannot take a send back, as mail.
fn mail_like() -> ChannelTraits {
    ChannelTraits {
        class: ActionClass::Speak,
        idempotency: Idempotency::Marker,
        undo: Undo::None,
        undo_window_ms: 0,
        max_bytes: 65_536,
    }
}

#[tokio::test]
async fn a_send_that_cannot_be_undone_waits_ten_seconds_and_stop_opens_the_draft_again() {
    let held = Held::through(pull_requests(), mail_like()).await;
    let now = held.rig.clock.now_ms();
    let rows = held.rig.items.send(&held.item_id, 1, None, "dashboard", false).await.expect("sent");
    assert_eq!((rows[0].state.as_str(), rows[0].send_at), ("holding", Some(now + 10_000)));
    held.deliver().await;
    assert!(held.channels.sent().is_empty(), "it waits out its hold");

    let stopped = held.rig.items.stop_delivery(&rows[0].id).await.expect("stopped");
    assert_eq!(stopped.state, "stopped");
    let item = held.rig.find(&held.item_id).await;
    assert_eq!((item.state, item.rev, item.answer, item.consumed_at), (ItemState::Open, 3, None, None));
    let waits = OutcomeCall::Held { run_id: "rn-1".into(), item_id: held.item_id.clone() };
    assert_eq!(held.rig.outcomes.calls().last(), Some(&waits), "the run waits for the user again");

    // Sent again, it goes once its hold is over, and the stopped send does not hold the run back.
    held.rig.items.send(&held.item_id, 3, None, "dashboard", false).await.expect("sent again");
    held.rig.clock.advance(10_000);
    held.deliver().await;
    assert_eq!(held.channels.sent().len(), 1);
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::SentUnedited };
    assert_eq!(held.rig.outcomes.calls().last(), Some(&finished));
}

#[tokio::test]
async fn stopping_one_target_while_another_went_out_opens_the_draft_for_the_stopped_one_only() {
    let mut confirmed = pull_requests();
    let other: eos_contracts::Recipient = serde_json::from_value(serde_json::json!({"id": "pr2",
        "kind": "item_place", "channel": "github", "bound": {"fact": "repo", "in": ["acme/game"]}}))
    .expect("a recipient");
    confirmed.goes_to.push(other);
    let held = Held::through(confirmed, mail_like()).await;
    held.rig.temp.exec(&format!(
        "UPDATE inbox_items SET payload = json_insert(payload, '$.targets[#]', \
         json('{{\"recipientId\":\"pr2\",\"place\":{{\"item\":\"github:pr:acme/game#483@abc\"}}}}')) \
         WHERE id = '{}'",
        held.item_id
    ));
    let rows = held.rig.items.send(&held.item_id, 1, None, "dashboard", false).await.expect("sent");
    assert_eq!(rows.iter().map(|row| row.target_ref.as_str()).collect::<Vec<_>>(), ["pr", "pr2"]);
    held.rig.temp.exec(&format!("UPDATE inbox_deliveries SET state = 'sent' WHERE id = '{}'", rows[1].id));

    held.rig.items.stop_delivery(&rows[0].id).await.expect("stopped");
    let item = held.rig.find(&held.item_id).await;
    assert_eq!(item.state, ItemState::Open);
    let again = held.rig.items.send(&held.item_id, item.rev, None, "dashboard", false).await.expect("sent again");
    assert_eq!(again.iter().map(|row| row.target_ref.as_str()).collect::<Vec<_>>(), ["pr"], "pr2 went out already");
}

#[tokio::test]
async fn a_send_its_channel_can_undo_goes_at_once_and_cannot_be_stopped_once_out() {
    let held = Held::new().await;
    let rows = held.rig.items.send(&held.item_id, 1, None, "dashboard", false).await.expect("sent");
    assert_eq!((rows[0].state.as_str(), rows[0].send_at), ("queued", Some(held.rig.clock.now_ms())));
    held.deliver().await;
    assert_eq!(held.channels.sent().len(), 1);
    match held.rig.items.stop_delivery(&rows[0].id).await {
        Err(Error::Core(eos_core::Error::Conflict(_))) => {}
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn an_automatic_send_a_day_old_is_held_as_a_draft_instead() {
    let sender = Sender::new();
    let made = sender.rig.clock.now_ms();
    sender.queue("dl-1", "github", "pr", "queued", "auto", made).await;
    sender.rig.clock.set(made + 25 * 60 * 60 * 1000);
    sender.pass().await;
    assert!(sender.sent().is_empty());
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("stopped", Some("auto_stale")));
    let items = sender.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    let draft = items.iter().find(|item| item.kind == ItemKind::Draft).expect("held as a draft");
    let waits = OutcomeCall::Held { run_id: "rn-1".into(), item_id: draft.id.clone() };
    assert_eq!(sender.outcomes.calls(), [waits]);
}

#[tokio::test]
async fn a_send_that_waited_for_its_capability_goes_once_its_channel_is_back() {
    let sender = Sender::new();
    sender.queue("dl-1", "mail", "boss", "queued", "auto", sender.rig.clock.now_ms()).await;
    sender.pass().await;
    assert_eq!(sender.row("dl-1").await.state, "waiting_capability");
    sender.pass().await;
    assert_eq!(sender.row("dl-1").await.state, "waiting_capability", "it waits while there is no channel");

    let _ = sender.channels.clone().with("mail", mail_like());
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-1"]);
    assert_eq!(sender.row("dl-1").await.state, "sent");
}
