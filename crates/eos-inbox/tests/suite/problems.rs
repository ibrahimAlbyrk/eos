//! Answering a delivery problem settles the run: try again queues the send
//! afresh and wakes the engine, "I sent it myself" finishes the run, "Don't
//! send" fails its delivery for good.

use std::time::Duration;

use eos_contracts::{InboxAnswer, ProblemChoice};
use eos_core::Clock;
use eos_core::store::StoredItem;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use eos_testkit::OutcomeCall;

use crate::delivery::Sender;

impl Sender {
    /// The one open `delivery_problem` item.
    async fn problem(&self) -> StoredItem {
        let items = self.rig.temp.port().read(|tx| tx.inbox_items().waiting(100)).await.expect("reads");
        let mut problems: Vec<StoredItem> =
            items.into_iter().filter(|item| item.kind == ItemKind::DeliveryProblem).collect();
        assert_eq!(problems.len(), 1, "one problem");
        problems.remove(0)
    }

    async fn answer(&self, choice: ProblemChoice) -> StoredItem {
        let item = self.problem().await;
        let answer = InboxAnswer::DeliveryProblem { choice, doc: None };
        self.rig.items.answer(&item.id, item.rev, &answer, "dashboard").await.expect("answered")
    }

    /// An approval Eos quit on for two hours: failed, with a problem.
    async fn stale_approval(&self) {
        let approved = self.rig.clock.now_ms();
        self.queue("dl-1", "github", "pr", "queued", "approved", approved).await;
        self.rig.clock.set(approved + 2 * 60 * 60 * 1000);
        self.pass().await;
        assert_eq!(self.row("dl-1").await.state, "failed");
    }

    /// A send a crash cut off, through a channel that cannot tell: "Did it go out?".
    async fn unknown(&self) {
        self.queue("dl-1", "sms", "me", "sending", "auto", self.rig.clock.now_ms()).await;
        self.engine.launch().await.expect("marks");
        self.pass().await;
        assert_eq!(self.row("dl-1").await.state, "uncertain");
    }
}

#[tokio::test]
async fn try_again_queues_the_send_as_approved_now_wakes_the_engine_and_it_goes_out() {
    let sender = Sender::new();
    sender.stale_approval().await;
    let item = sender.answer(ProblemChoice::Retry).await;
    let item = sender.rig.find(&item.id).await;
    assert_eq!((item.state, item.consumed_at.is_some()), (ItemState::Answered, true));
    let now = sender.rig.clock.now_ms();
    let row = sender.row("dl-1").await;
    assert_eq!(
        (row.state.as_str(), row.attempts, row.approved_at, row.next_attempt_at),
        ("queued", 0, Some(now), Some(now))
    );
    let woken = tokio::time::timeout(Duration::from_secs(1), sender.rig.wake.notified()).await;
    assert!(woken.is_ok(), "the delivery engine is woken");

    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-1"]);
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::AutoSent };
    assert_eq!(sender.outcomes.calls(), [finished]);
}

#[tokio::test]
async fn i_sent_it_myself_records_the_send_and_finishes_the_run() {
    let sender = Sender::new();
    sender.unknown().await;
    sender.answer(ProblemChoice::MarkSent).await;
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.sent_at), ("sent", Some(sender.rig.clock.now_ms())));
    assert!(sender.sent().is_empty(), "nothing is sent again");
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::AutoSent };
    assert_eq!(sender.rig.outcomes.calls(), [finished]);
}

#[tokio::test]
async fn dont_send_stops_the_send_and_fails_the_runs_delivery_for_good() {
    let sender = Sender::new();
    sender.stale_approval().await;
    sender.answer(ProblemChoice::Discard).await;
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("stopped", Some("discarded")));
    let failed = OutcomeCall::DeliveryFailed { run_id: "rn-1".into(), reason: "approval_stale".into() };
    assert_eq!(sender.rig.outcomes.calls(), [failed]);
    sender.pass().await;
    assert!(sender.sent().is_empty());
}
