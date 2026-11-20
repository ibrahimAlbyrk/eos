//! Sending a held draft: refused on a rev the user did not see; queued as
//! approved with what the user changed kept; the run finishes `sent_unedited`
//! or `sent_edited` once its delivery went out; a discard ends it.

use std::sync::Arc;

use eos_contracts::{ActionClass, Part, ResultDoc};
use eos_core::Clock;
use eos_core::routine::{GateDecision, RoutineControl, RunGate};
use eos_core::store::{StoredEdit, StoredOutcome};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use eos_inbox::Error;
use eos_inbox::delivery::{Delivery, DeliveryParts};
use eos_inbox::gate::Gate;
use eos_testkit::{FakeChannels, FakeSleeper, OutcomeCall, TempStore};
use serde_json::{Value, json};

use crate::gate::{input, review_traits};
use crate::rig::Rig;

struct Held {
    rig: Rig,
    engine: Arc<Delivery>,
    channels: FakeChannels,
    item_id: String,
    _control: Arc<dyn RoutineControl>,
}

fn part(key: &str, role: &str, text: &str) -> Part {
    Part { key: key.into(), role: role.into(), text: text.into(), meta: Default::default() }
}

/// A review with two line comments.
fn commented() -> ResultDoc {
    let mut doc = crate::gate::review("Two things.");
    doc.parts.push(part("c:1", "comment", "Rename this."));
    doc.parts.push(part("c:2", "comment", "Add a test."));
    doc
}

impl Held {
    /// Run `rn-1`'s review, held as a draft at rung Draft; the run waits on it.
    async fn new() -> Self {
        let channels = FakeChannels::new().with("github", review_traits(ActionClass::Speak));
        let rig = Rig::with_channels(TempStore::new(), channels.clone());
        let gate = Gate::new(Arc::new(channels.clone()), rig.zone.clone(), rig.clock.clone());
        let control: Arc<dyn RoutineControl> = rig.control.clone();
        gate.attach(&control);
        rig.temp.exec(
            "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
             VALUES ('rn-1', 'rt-1', 'standing', 'hand', '{}', 'checking', 0, 'mac-1', 1, 1)",
        );
        let (ids, now) = (rig.ids.clone(), rig.clock.now_ms());
        let input = eos_core::routine::GateInput { doc: commented(), ..input("draft") };
        let gate = Arc::new(gate);
        let decision = rig
            .temp
            .port()
            .write(move |tx, out| gate.apply_in(tx, out, now, ids.as_ref(), &input))
            .await
            .expect("the gate decides");
        let GateDecision::Held { item_id } = decision else { panic!("not held: {decision:?}") };
        rig.temp.exec("UPDATE runs SET state = 'waiting_for_user' WHERE id = 'rn-1'");
        let engine = Arc::new(Delivery::new(DeliveryParts {
            store: rig.temp.port(),
            clock: rig.clock.clone(),
            sleeper: Arc::new(FakeSleeper::default()),
            ids: rig.ids.clone(),
            zone: rig.zone.clone(),
            channels: Arc::new(channels.clone()),
            control: control.clone(),
            outcomes: rig.outcomes.clone(),
            wake: rig.wake.clone(),
        }));
        Self { rig, engine, channels, item_id, _control: control }
    }

    /// The routines move the run on as they hear it delivering; then the
    /// engine sends.
    async fn deliver(&self) {
        self.rig.temp.exec("UPDATE runs SET state = 'delivering' WHERE id = 'rn-1'");
        self.engine.pass().await.expect("a pass");
    }

    async fn edits(&self) -> Vec<StoredEdit> {
        self.rig.temp.port().read(|tx| tx.inbox_edits().since(0, 10)).await.expect("reads")
    }

    async fn outcomes(&self) -> Vec<StoredOutcome> {
        self.rig.temp.port().read(|tx| tx.inbox_outcomes().by_routine("rt-1", 10)).await.expect("reads")
    }
}

#[tokio::test]
async fn a_send_on_a_rev_the_user_did_not_see_is_refused() {
    let held = Held::new().await;
    held.rig.items.save_draft(&held.item_id, 1, &commented()).await.expect("saved");
    match held.rig.items.send(&held.item_id, 1, None, "phone").await {
        Err(Error::Changed { rev }) => assert_eq!(rev, 2),
        other => panic!("{other:?}"),
    }
    assert_eq!(held.rig.temp.count("SELECT COUNT(*) FROM inbox_deliveries"), 0);
}

#[tokio::test]
async fn an_unedited_send_queues_an_approved_delivery_and_finishes_sent_unedited() {
    let held = Held::new().await;
    let rows = held.rig.items.send(&held.item_id, 1, None, "dashboard").await.expect("sent");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    let now = held.rig.clock.now_ms();
    assert_eq!((row.state.as_str(), row.mode.as_str(), row.approved_at), ("queued", "approved", Some(now)));
    assert_eq!(row.item_id.as_deref(), Some(held.item_id.as_str()));
    let target: Value = serde_json::from_str(&row.target).expect("json");
    assert_eq!(target, json!({"recipientId": "pr", "place": {"item": "github:pr:acme/game#482"}}));
    let item = held.rig.find(&held.item_id).await;
    assert_eq!(
        (item.state, item.answered_by.as_deref(), item.consumed_at.is_some()),
        (ItemState::Answered, Some("dashboard"), true)
    );
    assert_eq!(held.rig.outcomes.calls(), [OutcomeCall::Delivering("rn-1".into())]);
    assert!(held.edits().await.is_empty());

    held.deliver().await;
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::SentUnedited };
    assert_eq!(held.rig.outcomes.calls().last(), Some(&finished));
    let outcomes = held.outcomes().await;
    assert_eq!(outcomes.len(), 1);
    let outcome = &outcomes[0].outcome;
    assert_eq!((outcome.outcome.as_str(), outcome.rung.as_str()), ("sent_unedited", "draft"));
    assert_eq!(outcome.delivery_id.as_deref(), Some(row.id.as_str()));
}

#[tokio::test]
async fn a_removed_comment_is_an_edit_and_the_run_finishes_sent_edited() {
    let held = Held::new().await;
    let mut edited = commented();
    edited.parts.retain(|part| part.key != "c:2");
    let rows = held.rig.items.send(&held.item_id, 1, Some(edited.clone()), "phone").await.expect("sent");
    let body: ResultDoc = serde_json::from_str(&rows[0].body).expect("json");
    assert_eq!(body, edited);

    let edits = held.edits().await;
    assert_eq!(edits.len(), 1);
    let edit = &edits[0].edit;
    assert_eq!((edit.removed, edit.changed, edit.added, edit.moved), (1, 0, 0, 0));
    assert_eq!(edit.delivery_id.as_deref(), Some(rows[0].id.as_str()));
    assert!(edit.derived_from_untrusted, "the review was made from a pull request");
    let ops: Value = serde_json::from_str(&edit.ops).expect("json");
    assert_eq!((ops[0]["key"].as_str(), ops[0]["op"].as_str()), (Some("c:2"), Some("removed")));

    held.deliver().await;
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::SentEdited };
    assert_eq!(held.rig.outcomes.calls().last(), Some(&finished));
    assert_eq!(held.outcomes().await[0].outcome.outcome, "sent_edited");

    // Memory reads the same edit through the port.
    use eos_core::inbox::ResultEdits;
    let read = eos_inbox::Edits::new(held.rig.temp.port()).list_since(0, 10).await.expect("reads");
    assert_eq!((read.len(), read[0].after.parts.len()), (1, 3));
}

#[tokio::test]
async fn a_discarded_draft_ends_its_run_discarded() {
    let held = Held::new().await;
    held.rig.items.discard(&held.item_id, 1, "dashboard").await.expect("discarded");
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Discarded };
    assert_eq!(held.rig.outcomes.calls(), [finished]);
    assert_eq!(held.outcomes().await[0].outcome.outcome, "discarded");
    assert_eq!(held.rig.temp.count("SELECT COUNT(*) FROM inbox_deliveries"), 0);
    assert!(held.rig.items.unconsumed("inbox").await.expect("reads").is_empty());
}

#[tokio::test]
async fn a_send_that_went_stale_and_was_sent_again_finishes_the_run() {
    let held = Held::new().await;
    held.rig.items.send(&held.item_id, 1, None, "dashboard").await.expect("sent");
    held.channels.stale("new commits");
    held.deliver().await;
    let waiting = held.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    let again = waiting.into_iter().find(|item| item.kind == ItemKind::Draft).expect("held again");

    held.rig.items.send(&again.id, again.rev, None, "dashboard").await.expect("sent again");
    held.deliver().await;
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::SentUnedited };
    assert_eq!(held.rig.outcomes.calls().last(), Some(&finished));
    let outcomes = held.outcomes().await;
    assert_eq!(outcomes.iter().map(|row| row.outcome.outcome.as_str()).collect::<Vec<_>>(), ["sent_unedited"]);
}
