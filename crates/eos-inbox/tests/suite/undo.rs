//! After a send: Undo inside its channel's window takes it back and ends
//! the run `undone`, outside it is refused; "that was wrong" writes one
//! outcome row; either drops a routine that sent by itself back to drafts.
//! A failed send is tried again with a fresh ladder, edited or not.

use eos_contracts::ActionClass;
use eos_core::Clock;
use eos_core::delivery::{SendErrorKind, UndoOutcome};
use eos_domain::routine::numbers::Outcome;
use eos_inbox::Error;
use eos_testkit::{ControlCall, OutcomeCall};

use crate::delivery::{Sender, failure};
use crate::gate::{review, review_traits};
use crate::rig::pull_requests;
use crate::send::Held;

impl Sender {
    /// An automatic send of run `rn-1` that went out, with an undo window.
    async fn sent_alone(&self) {
        self.queue("dl-1", "github", "pr", "queued", "auto", self.rig.clock.now_ms()).await;
        self.pass().await;
        assert_eq!(self.row("dl-1").await.state, "sent");
    }

    fn outcome_rows(&self, outcome: &str) -> i64 {
        self.rig.temp.count(&format!("SELECT COUNT(*) FROM inbox_outcomes WHERE outcome = '{outcome}'"))
    }

    fn stepped_down(&self) -> Vec<String> {
        let calls = self.rig.control.calls().into_iter();
        calls
            .filter_map(|call| if let ControlCall::StepDown { reason, .. } = call { Some(reason) } else { None })
            .collect()
    }
}

#[tokio::test]
async fn undo_inside_the_window_takes_the_send_back_and_ends_the_run_undone() {
    let sender = Sender::new();
    sender.sent_alone().await;
    let partial = sender.rig.items.undo("dl-1").await.expect("undone");
    assert!(!partial);
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.undone_at), ("undone", Some(sender.rig.clock.now_ms())));
    assert_eq!(sender.channels.undone().len(), 1);
    assert_eq!(sender.outcome_rows("undone"), 1);
    let ended = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Undone };
    assert_eq!(sender.rig.outcomes.calls(), [ended]);
    assert_eq!(sender.stepped_down(), ["undo"], "a routine that sent by itself holds drafts again");
}

#[tokio::test]
async fn undo_outside_the_window_or_twice_is_refused() {
    let sender = Sender::new();
    sender.sent_alone().await;
    sender.rig.clock.advance(2_000);
    assert!(matches!(sender.rig.items.undo("dl-1").await, Err(Error::CannotUndo)));
    assert!(sender.channels.undone().is_empty());
    assert_eq!(sender.row("dl-1").await.state, "sent");
}

#[tokio::test]
async fn an_undo_that_leaves_some_behind_is_recorded_as_undone_and_says_so() {
    let sender = Sender::new();
    sender.sent_alone().await;
    sender.channels.undoes(UndoOutcome::Partial);
    assert!(sender.rig.items.undo("dl-1").await.expect("undone"), "partial");
    assert_eq!(sender.row("dl-1").await.state, "undone");
    assert!(matches!(sender.rig.items.undo("dl-1").await, Err(Error::CannotUndo)), "once");
}

#[tokio::test]
async fn that_was_wrong_writes_one_outcome_row_and_leaves_the_send_as_it_is() {
    let sender = Sender::new();
    sender.sent_alone().await;
    let row = sender.rig.items.wrong("dl-1").await.expect("noted");
    assert_eq!(row.state, "sent");
    assert_eq!(sender.outcome_rows("wrong"), 1);
    assert!(sender.rig.outcomes.calls().is_empty(), "it settles no run");
    assert_eq!(sender.stepped_down(), ["wrong"]);
    let again = sender.rig.items.wrong("dl-1").await.expect("noted once");
    assert_eq!(again, row, "a second flag answers as the first did");
    assert_eq!(sender.outcome_rows("wrong"), 1, "and records nothing more");
    assert_eq!(sender.stepped_down(), ["wrong"]);

    let held = Held::new().await;
    let rows = held.rig.items.send(&held.item_id, 1, None, "dashboard", false).await.expect("sent");
    held.deliver().await;
    held.rig.items.wrong(&rows[0].id).await.expect("noted");
    let stepped = held.rig.control.calls().into_iter().any(|call| matches!(call, ControlCall::StepDown { .. }));
    assert!(!stepped, "a send the user approved changes no Freedom");
}

#[tokio::test]
async fn a_failed_send_goes_again_with_a_fresh_ladder_and_its_problem_is_answered() {
    let sender = Sender::new();
    sender.queue("dl-1", "github", "pr", "queued", "approved", sender.rig.clock.now_ms()).await;
    sender.channels.script(Err(failure(SendErrorKind::Permanent, "validation")));
    sender.pass().await;
    assert_eq!(sender.problems().await.len(), 1);

    let row = sender.rig.items.retry("dl-1", None, "phone").await.expect("queued again");
    let now = sender.rig.clock.now_ms();
    assert_eq!((row.state.as_str(), row.attempts, row.approved_at), ("queued", 0, Some(now)));
    assert!(sender.problems().await.is_empty(), "the problem that asked is answered");
    sender.pass().await;
    assert_eq!(sender.row("dl-1").await.state, "sent");
    assert!(matches!(
        sender.rig.items.retry("dl-1", None, "phone").await,
        Err(Error::Core(eos_core::Error::Conflict(_)))
    ));
}

#[tokio::test]
async fn edit_and_retry_sends_the_edited_result_and_keeps_the_edit() {
    let held = Held::through(pull_requests(), review_traits(ActionClass::Speak)).await;
    let rows = held.rig.items.send(&held.item_id, 1, None, "dashboard", false).await.expect("sent");
    held.channels.script(Err(failure(SendErrorKind::Permanent, "validation")));
    held.deliver().await;
    let edited = review("Shorter.");
    let row = held.rig.items.retry(&rows[0].id, Some(edited.clone()), "dashboard").await.expect("queued again");
    assert_eq!(serde_json::from_str::<eos_contracts::ResultDoc>(&row.body).expect("json"), edited);
    assert_eq!(held.edits().await.len(), 1, "what the user changed is kept");
    held.deliver().await;
    let sent = held.channels.sent();
    assert_eq!(sent.last().map(|req| req.body.clone()), Some(edited));
}

#[tokio::test]
async fn that_was_wrong_holds_every_automatic_send_of_the_routine_that_has_not_gone_out() {
    let sender = Sender::new();
    sender.sent_alone().await;
    let now = sender.rig.clock.now_ms();
    // A second result in its hold, one waiting for its capability, and one the user approved.
    sender.queue("dl-2", "github", "boss", "holding", "auto", now + 120_000).await;
    sender.queue("dl-3", "github", "team", "waiting_capability", "auto", now).await;
    sender.queue("dl-4", "github", "lead", "queued", "approved", now + 120_000).await;

    sender.rig.items.wrong("dl-1").await.expect("noted");
    assert_eq!(sender.stepped_down(), ["wrong"]);
    for id in ["dl-2", "dl-3"] {
        let row = sender.row(id).await;
        assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("stopped", Some("stepped_down")), "{id}");
    }
    assert_eq!(sender.row("dl-4").await.state, "queued", "what the user sent stays on its way");
    let items = sender.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    assert!(items.iter().any(|item| item.kind.as_str() == "draft"), "the held results wait for the user");

    sender.rig.clock.advance(121_000);
    sender.pass().await;
    let keys = sender.sent();
    assert_eq!(keys.len(), 2, "only the first send and the approved one went out: {keys:?}");
}
