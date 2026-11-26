//! An action a run's agent calls that reaches past this computer (D73),
//! over the real store: held as a draft below the automatic rungs and sent
//! once the user sends it, also after the run ended; sent by itself at On
//! its own and taken back with the routine stepping down; a second one to
//! the same person about the same item held (D55); what cannot be taken
//! back held; telling the user runs; nothing goes from a trial or while Eos
//! is stopped. None of it moves the run.

use std::sync::Arc;

use eos_contracts::{ActionClass, Freedom};
use eos_core::Clock;
use eos_core::capability::{RunAction, RunActionDecision};
use eos_core::delivery::{ChannelTraits, Idempotency, Undo};
use eos_core::routine::{GateInput, GateMode, RoutineControl, RunGate, RunOutcomes};
use eos_domain::result_doc::action_doc;
use eos_inbox::delivery::{Delivery, DeliveryParts};
use eos_inbox::gate::{STOPPED, TRIAL};
use eos_testkit::{ControlCall, FakeChannels, FakeSleeper};
use serde_json::{Value, json};

use crate::gate::{Gated, input};

const SLACK: &str = "action:slack";

struct Acting {
    gated: Gated,
    engine: Arc<Delivery>,
}

impl Acting {
    fn new() -> Self {
        let traits = ChannelTraits {
            class: ActionClass::Speak,
            idempotency: Idempotency::None,
            undo: Undo::Full,
            undo_window_ms: 86_400_000,
            max_bytes: usize::MAX,
        };
        let gated = Gated::over(FakeChannels::new().with(SLACK, traits));
        gated.rig.temp.exec("UPDATE runs SET state = 'running' WHERE id = 'rn-1'");
        let control: Arc<dyn RoutineControl> = gated.rig.control.clone();
        let outcomes: Arc<dyn RunOutcomes> = gated.rig.outcomes.clone();
        let engine = Arc::new(Delivery::new(DeliveryParts {
            store: gated.rig.temp.port(),
            clock: gated.rig.clock.clone(),
            sleeper: Arc::new(FakeSleeper::default()),
            ids: gated.rig.ids.clone(),
            zone: gated.rig.zone.clone(),
            channels: Arc::new(gated.channels.clone()),
            control,
            outcomes,
            wake: Arc::new(tokio::sync::Notify::new()),
        }));
        Self { gated, engine }
    }

    async fn act(&self, rung: &str, mode: GateMode, action: RunAction) -> RunActionDecision {
        let freedom: Freedom = serde_json::from_value(json!({"rung": rung})).expect("a freedom");
        let doc = action_doc(&action.capability, &action.action, &action.input);
        let input = GateInput { doc, result_mode: mode, freedom_confirmed: Some(freedom), ..input("draft") };
        let (gate, ids, now) = (self.gated.gate.clone(), self.gated.rig.ids.clone(), self.gated.rig.clock.now_ms());
        self.gated
            .rig
            .temp
            .port()
            .write(move |tx, out| gate.action_in(tx, out, now, ids.as_ref(), &input, &action))
            .await
            .expect("the gate decides")
    }

    async fn pass(&self) {
        self.engine.pass().await.expect("a pass");
    }

    async fn state(&self, id: &str) -> String {
        let id = id.to_owned();
        let row = self.gated.rig.temp.port().read(move |tx| tx.inbox_deliveries().find(&id)).await.expect("reads");
        row.expect("a row").state
    }
}

fn dm(to: &str, class: ActionClass) -> RunAction {
    RunAction {
        worker_id: "w-lead".into(),
        capability: "slack".into(),
        action: "post_message".into(),
        class,
        input: json!({"to": to, "text": "Your pull request needs a rebase."}),
        recipient: Some(to.into()),
        to_user: false,
    }
}

fn held(decision: &RunActionDecision) -> String {
    match decision {
        RunActionDecision::Held { item_id } => item_id.clone(),
        other => panic!("not held: {other:?}"),
    }
}

fn queued(decision: &RunActionDecision) -> String {
    match decision {
        RunActionDecision::Queued { delivery_id } => delivery_id.clone(),
        other => panic!("not queued: {other:?}"),
    }
}

#[tokio::test]
async fn below_the_automatic_rungs_it_waits_as_a_draft_and_goes_when_the_user_sends_it_after_the_run_ended() {
    let acting = Acting::new();
    for (rung, mode) in [("ask", GateMode::AsUsual), ("draft", GateMode::AsUsual), ("on_its_own", GateMode::Ask)] {
        held(&acting.act(rung, mode, dm("U1", ActionClass::Speak)).await);
    }
    assert_eq!(acting.gated.rows(), 0, "nothing is queued while it waits");
    let item =
        acting.gated.rig.find(&held(&acting.act("draft", GateMode::AsUsual, dm("U1", ActionClass::Speak)).await)).await;
    assert_eq!((item.kind.as_str(), item.title.as_str(), item.subject_key), ("draft", "slack · post message", None));
    let payload: Value = serde_json::from_str(&item.payload).expect("json");
    assert_eq!(payload["targets"], json!([{"recipientId": "slack:U1", "place": {"address": "U1"}}]));
    assert_eq!(payload["doc"]["channel"], SLACK);

    acting.gated.rig.temp.exec("UPDATE runs SET state = 'done' WHERE id = 'rn-1'");
    let rows = acting.gated.rig.items.send(&item.id, item.rev, None, "user", false).await.expect("sent");
    acting.pass().await;
    assert_eq!(acting.state(&rows[0].id).await, "sent");
    let sent = acting.gated.channels.sent();
    assert_eq!((sent.len(), sent[0].channel.as_str(), sent[0].action.as_str()), (1, SLACK, "post_message"));
    assert!(acting.gated.rig.outcomes.calls().is_empty(), "the run ends by its own result");
}

#[tokio::test]
async fn on_its_own_it_goes_by_itself_and_an_undo_takes_it_back_and_steps_the_routine_down() {
    let acting = Acting::new();
    let id = queued(&acting.act("on_its_own", GateMode::AsUsual, dm("U1", ActionClass::Speak)).await);
    assert_eq!(acting.gated.items(), 0);
    acting.pass().await;
    assert_eq!(acting.state(&id).await, "sent");
    assert_eq!(acting.gated.channels.sent().len(), 1);

    acting.gated.rig.items.undo(&id).await.expect("taken back");
    assert_eq!((acting.state(&id).await, acting.gated.channels.undone().len()), ("undone".to_owned(), 1));
    let stepped = acting.gated.rig.control.calls().into_iter().any(|call| matches!(call, ControlCall::StepDown { .. }));
    assert!(stepped, "a routine whose send by itself was taken back holds drafts again");
    assert!(acting.gated.rig.outcomes.calls().is_empty(), "the run goes on");
}

#[tokio::test]
async fn a_second_send_to_the_same_person_about_the_same_item_waits_for_the_user() {
    let acting = Acting::new();
    queued(&acting.act("on_its_own", GateMode::AsUsual, dm("U1", ActionClass::Speak)).await);
    held(&acting.act("on_its_own", GateMode::AsUsual, dm("U1", ActionClass::Speak)).await);
    queued(&acting.act("on_its_own", GateMode::AsUsual, dm("U2", ActionClass::Speak)).await);
}

#[tokio::test]
async fn what_cannot_be_taken_back_waits_and_telling_the_user_runs() {
    let acting = Acting::new();
    let item = acting
        .gated
        .rig
        .find(&held(&acting.act("on_its_own", GateMode::AsUsual, dm("U1", ActionClass::Irreversible)).await))
        .await;
    assert!(item.summary.contains("cannot be taken back"), "{}", item.summary);
    // A "tell the user" that names someone else is no note to the user.
    held(&acting.act("on_its_own", GateMode::AsUsual, dm("U1", ActionClass::TellUser)).await);
    let note = RunAction { to_user: true, recipient: None, ..dm("", ActionClass::TellUser) };
    assert_eq!(acting.act("draft", GateMode::AsUsual, note).await, RunActionDecision::Run);
    assert_eq!(acting.gated.rows(), 0);
}

#[tokio::test]
async fn nothing_goes_from_a_trial_or_while_eos_is_stopped() {
    let acting = Acting::new();
    let refused = |reason: &str| RunActionDecision::Refused { reason: reason.to_owned() };
    let note = RunAction { to_user: true, recipient: None, ..dm("", ActionClass::TellUser) };
    for action in [dm("U1", ActionClass::Speak), dm("U1", ActionClass::Irreversible), note.clone()] {
        assert_eq!(acting.act("on_its_own", GateMode::Trial, action).await, refused(TRIAL));
    }
    acting.gated.rig.items.halt("user").await.expect("stopped");
    for action in [dm("U1", ActionClass::Speak), note] {
        assert_eq!(acting.act("on_its_own", GateMode::AsUsual, action).await, refused(STOPPED));
    }
    assert_eq!((acting.gated.rows(), acting.gated.items()), (0, 0));
}
