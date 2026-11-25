//! The delivery engine over the real store and fake channels: the retry
//! ladder, unknown sends after a crash per idempotency kind, one send at a
//! time per target in order, an approval Eos quit on, refusals that no
//! retry helps, a subject that moved on, and the loop woken by the gate.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::ActionClass;
use eos_core::Clock;
use eos_core::delivery::{ChannelTraits, Idempotency, Receipt, SendError, SendErrorKind, Undo};
use eos_core::routine::{Confirmed, GateDecision, GateInput, RoutineControl, RunGate, RunOutcomes};
use eos_core::store::StoredDelivery;
use eos_domain::routine::numbers::Outcome;
use eos_inbox::delivery::{Delivery, DeliveryParts};
use eos_inbox::gate::Gate;
use eos_testkit::{FakeChannels, FakeRunOutcomes, FakeSleeper, OutcomeCall, TempStore};
use serde_json::{Value, json};

use crate::gate::{Gated, input, review};
use crate::rig::{Rig, pull_requests};

fn traits(idempotency: Idempotency) -> ChannelTraits {
    ChannelTraits {
        class: ActionClass::Speak,
        idempotency,
        undo: Undo::Partial,
        undo_window_ms: 1_000,
        max_bytes: 65_536,
    }
}

pub(crate) struct Sender {
    pub(crate) rig: Rig,
    pub(crate) channels: FakeChannels,
    pub(crate) outcomes: Arc<FakeRunOutcomes>,
    pub(crate) engine: Arc<Delivery>,
}

impl Sender {
    pub(crate) fn new() -> Self {
        Self::confirming(pull_requests())
    }

    /// Over a routine whose confirmed Goes to is `confirmed`.
    pub(crate) fn confirming(confirmed: Confirmed) -> Self {
        Self::sleeping(confirmed, Arc::new(FakeSleeper::default()))
    }

    /// The engine and the user's side send, and take back, through the same channels.
    fn sleeping(confirmed: Confirmed, sleeper: Arc<FakeSleeper>) -> Self {
        let channels = FakeChannels::new()
            .with("github", traits(Idempotency::Marker))
            .with("native", traits(Idempotency::Native))
            .with("sms", traits(Idempotency::None));
        let rig = Rig::with_channels(TempStore::new(), channels.clone(), confirmed);
        let outcomes = Arc::new(FakeRunOutcomes::new());
        let control: Arc<dyn RoutineControl> = rig.control.clone();
        let engine = Arc::new(Delivery::new(DeliveryParts {
            store: rig.temp.port(),
            clock: rig.clock.clone(),
            sleeper,
            ids: rig.ids.clone(),
            zone: rig.zone.clone(),
            channels: Arc::new(channels.clone()),
            control,
            outcomes: outcomes.clone(),
            wake: Arc::new(tokio::sync::Notify::new()),
        }));
        rig.temp.exec(
            "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
             VALUES ('rn-1', 'rt-1', 'standing', 'hand', '{}', 'delivering', 0, 'mac-1', 1, 1)",
        );
        Self { rig, channels, outcomes, engine }
    }

    /// A row of run `rn-1` to `target` through `channel`, made `at`.
    pub(crate) async fn queue(&self, id: &str, channel: &str, target: &str, state: &str, mode: &str, at: i64) {
        let doc = serde_json::to_string(&review("Looks good.")).expect("json");
        let row = StoredDelivery {
            id: id.into(),
            item_id: None,
            run_id: "rn-1".into(),
            routine_id: "rt-1".into(),
            channel: channel.into(),
            action: "post_review".into(),
            target_ref: target.into(),
            target: json!({"recipientId": target, "place": {"item": "github:pr:acme/game#482"}}).to_string(),
            body: doc,
            body_hash: "h".into(),
            class: ActionClass::Speak,
            mode: mode.into(),
            state: state.into(),
            send_at: Some(at),
            attempts: 0,
            next_attempt_at: Some(at),
            last_error_kind: None,
            partial: None,
            receipt: None,
            sent_at: None,
            undo_until: None,
            undone_at: None,
            approved_at: (mode == "approved").then_some(at),
            created_at: at,
            updated_at: at,
        };
        self.rig.temp.port().write(move |tx, _| tx.inbox_deliveries().insert(&row)).await.expect("queued");
    }

    pub(crate) async fn row(&self, id: &str) -> StoredDelivery {
        let id = id.to_owned();
        let row = self.rig.temp.port().read(move |tx| tx.inbox_deliveries().find(&id)).await.expect("reads");
        row.expect("a row")
    }

    pub(crate) async fn pass(&self) {
        self.engine.pass().await.expect("a pass");
    }

    /// The open `delivery_problem` items' payloads and summaries.
    pub(crate) async fn problems(&self) -> Vec<(Value, String)> {
        let items = self.rig.temp.port().read(|tx| tx.inbox_items().waiting(100)).await.expect("reads");
        items
            .into_iter()
            .filter(|item| item.kind.as_str() == "delivery_problem")
            .map(|item| (serde_json::from_str(&item.payload).expect("json"), item.summary))
            .collect()
    }

    pub(crate) fn sent(&self) -> Vec<String> {
        self.channels.sent().into_iter().map(|req| req.key).collect()
    }
}

pub(crate) fn failure(kind: SendErrorKind, detail: &str) -> SendError {
    SendError { kind, detail_kind: detail.into() }
}

#[tokio::test]
async fn a_send_goes_out_with_its_receipt_and_finishes_the_run() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-1", "github", "pr", "queued", "auto", now).await;
    sender.pass().await;
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.attempts, row.sent_at), ("sent", 1, Some(now)));
    assert_eq!(row.undo_until, Some(now + 1_000));
    assert_eq!(serde_json::from_str::<Value>(&row.receipt.unwrap_or_default()).expect("json")["id"], "rc-1");
    let finished = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::AutoSent };
    assert_eq!(sender.outcomes.calls(), [finished]);
    let delivered = sender.rig.temp.announced.list();
    assert!(delivered.iter().any(|(topic, payload)| *topic == "inbox:delivery" && payload.contains("\"sent\"")));
}

#[tokio::test]
async fn a_passing_failure_climbs_the_retry_ladder_then_fails_with_a_problem() {
    let sender = Sender::new();
    sender.queue("dl-1", "github", "pr", "queued", "auto", sender.rig.clock.now_ms()).await;
    let mut waits = Vec::new();
    for _ in 0..6 {
        sender.channels.script(Err(failure(SendErrorKind::Transient, "rate_limited")));
        sender.pass().await;
        let row = sender.row("dl-1").await;
        if let Some(next) = row.next_attempt_at {
            waits.push(next - sender.rig.clock.now_ms());
            sender.rig.clock.set(next);
        }
    }
    assert_eq!(waits, [30_000, 120_000, 600_000, 3_600_000, 14_400_000]);
    let row = sender.row("dl-1").await;
    assert_eq!((row.state.as_str(), row.attempts), ("failed", 6));
    let problems = sender.problems().await;
    assert_eq!(problems.len(), 1);
    let doc = serde_json::to_value(review("Looks good.")).expect("json");
    assert_eq!(problems[0].0, json!({"errorKind": "service", "deliveryId": "dl-1", "doc": doc}), "what a retry sends");
    assert!(sender.outcomes.calls().is_empty(), "the run waits on the user's answer");
}

#[tokio::test]
async fn a_send_a_crash_cut_off_is_looked_up_by_how_its_channel_repeats_safely() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-found", "github", "a", "sending", "auto", now).await;
    sender.queue("dl-marker", "github", "b", "sending", "auto", now).await;
    sender.queue("dl-native", "native", "c", "sending", "auto", now).await;
    sender.queue("dl-none", "sms", "d", "sending", "auto", now).await;
    sender.channels.left("dl-found", Receipt { id: "rc-old".into(), url: None });

    // The app comes back: what was sending is unknown, then looked up.
    sender.engine.launch().await.expect("marks");
    assert_eq!(sender.row("dl-none").await.state, "uncertain");
    sender.pass().await;
    let found = sender.row("dl-found").await;
    assert_eq!((found.state.as_str(), found.receipt.is_some()), ("sent", true));
    assert_eq!(sender.sent(), ["dl-marker", "dl-native"], "sent again under the same key; never the found one");
    assert_eq!(sender.row("dl-marker").await.state, "sent");
    assert_eq!(sender.row("dl-native").await.state, "sent");

    let unknown = sender.row("dl-none").await;
    assert_eq!((unknown.state.as_str(), unknown.next_attempt_at), ("uncertain", None), "asked, not repeated");
    let problems = sender.problems().await;
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].1, "Eos closed while it was sending. Did it go out?");
    sender.pass().await;
    assert_eq!(sender.problems().await.len(), 1, "asked once");
}

#[tokio::test]
async fn an_answer_lost_in_flight_is_found_and_never_sent_twice() {
    let sender = Sender::new();
    sender.queue("dl-1", "github", "pr", "queued", "auto", sender.rig.clock.now_ms()).await;
    sender.channels.script(Err(failure(SendErrorKind::Uncertain, "timeout")));
    sender.channels.left("dl-1", Receipt { id: "rc-9".into(), url: None });
    sender.pass().await;
    assert_eq!(sender.row("dl-1").await.state, "uncertain");
    sender.pass().await;
    assert_eq!(sender.row("dl-1").await.state, "sent");
    assert_eq!(sender.sent(), ["dl-1"], "one send");
}

#[tokio::test]
async fn a_send_its_channel_could_not_tell_about_asks_without_saying_eos_closed() {
    let sender = Sender::new();
    sender.queue("dl-1", "sms", "me", "queued", "auto", sender.rig.clock.now_ms()).await;
    sender.channels.script(Err(failure(SendErrorKind::Uncertain, "timeout")));
    sender.pass().await;
    assert_eq!(sender.row("dl-1").await.state, "uncertain");
    sender.pass().await;
    let problems = sender.problems().await;
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].1, "Eos could not tell whether it went out. Did it?");
    assert_eq!(sender.sent(), ["dl-1"], "never sent again");
}

#[tokio::test]
async fn one_send_at_a_time_goes_to_a_target_in_the_order_they_were_made() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-old", "github", "pr", "queued", "auto", now - 10).await;
    sender.queue("dl-new", "github", "pr", "queued", "auto", now - 5).await;
    sender.queue("dl-other", "github", "boss", "queued", "auto", now).await;
    // The newer one is due first: it still waits for the older.
    sender.rig.temp.exec("UPDATE inbox_deliveries SET next_attempt_at = 1 WHERE id = 'dl-new'");
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-old", "dl-other"]);
    assert_eq!(sender.row("dl-new").await.state, "queued");
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-old", "dl-other", "dl-new"]);
}

impl Sender {
    /// Run `run` of `routine` on `item` (made on the version after its `@`,
    /// as real runs are), its row `id` to the recipient `pr` made `at`,
    /// waiting on the retry ladder until `next`.
    async fn queue_on(&self, id: &str, run: &str, routine: &str, item: &str, at: i64, next: i64) {
        let version = item.rsplit_once('@').map(|(_, version)| version);
        let input = json!({ "item": { "version": version } });
        self.rig.temp.exec(&format!(
            "INSERT OR IGNORE INTO runs (id, routine_id, kind, origin, input, state, priority, device, item_key, \
             created_at, updated_at) VALUES ('{run}', '{routine}', 'standing', 'hand', '{input}', 'delivering', 0, \
             'mac-1', '{item}', 1, 1)"
        ));
        self.queue(id, "github", "pr", "queued", "auto", at).await;
        self.rig.temp.exec(&format!(
            "UPDATE inbox_deliveries SET run_id = '{run}', routine_id = '{routine}', next_attempt_at = {next} \
             WHERE id = '{id}'"
        ));
    }
}

#[tokio::test]
async fn a_send_on_the_retry_ladder_holds_back_the_next_send_to_the_same_pull_request() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue_on("dl-waiting", "rn-a", "rt-1", "github:pr:acme/game#1", now - 10, now + 14_400_000).await;
    sender.queue_on("dl-same", "rn-b", "rt-1", "github:pr:acme/game#1", now - 5, now).await;
    sender.pass().await;
    assert!(sender.sent().is_empty(), "the same pull request waits for the older send");
    assert_eq!(sender.row("dl-same").await.state, "queued");
}

#[tokio::test]
async fn sends_about_two_versions_of_one_pull_request_go_one_after_the_other() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue_on("dl-first", "rn-a", "rt-1", "github:pr:acme/game#482@aaa111", now - 10, now).await;
    sender.queue_on("dl-second", "rn-b", "rt-1", "github:pr:acme/game#482@bbb222", now - 5, now).await;
    sender.queue_on("dl-other-pr", "rn-c", "rt-1", "github:pr:acme/game#483@aaa111", now - 4, now).await;
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-first", "dl-other-pr"], "the newer version waits, another pull request does not");
    assert_eq!(sender.row("dl-second").await.state, "queued");
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-first", "dl-other-pr", "dl-second"]);
}

#[tokio::test]
async fn sends_to_other_pull_requests_or_of_other_routines_do_not_wait_on_one_another() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue_on("dl-waiting", "rn-a", "rt-1", "github:pr:acme/game#1", now - 10, now + 14_400_000).await;
    sender.queue_on("dl-other-pr", "rn-b", "rt-1", "github:pr:acme/game#2", now - 5, now).await;
    sender.queue_on("dl-other-routine", "rn-c", "rt-2", "github:pr:acme/game#1", now - 4, now).await;
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-other-pr", "dl-other-routine"]);
}

#[tokio::test]
async fn an_approval_eos_quit_on_for_over_an_hour_asks_again_instead_of_sending() {
    let sender = Sender::new();
    // 18:02 in Istanbul (UTC+3).
    let approved = 1_790_002_920_000;
    sender.queue("dl-1", "github", "pr", "queued", "approved", approved).await;
    sender.rig.clock.set(approved + 2 * 60 * 60 * 1000);
    sender.pass().await;
    assert!(sender.sent().is_empty());
    assert_eq!(sender.row("dl-1").await.state, "failed");
    let problems = sender.problems().await;
    assert_eq!(problems[0].1, "Approved at 18:02, Eos closed before sending. Send now?");
    assert_eq!(problems[0].0["errorKind"], "internal");
}

#[tokio::test]
async fn a_draft_of_the_users_own_or_their_own_pull_request_fails_at_once_without_a_retry() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-draft", "github", "a", "queued", "approved", now).await;
    sender.queue("dl-own", "github", "b", "queued", "approved", now).await;
    sender.channels.script(Err(failure(SendErrorKind::UserDraftInProgress, "user_draft_in_progress")));
    sender.channels.script(Err(failure(SendErrorKind::Permanent, "own_pull_request")));
    sender.pass().await;
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-draft", "dl-own"], "each tried once");
    for id in ["dl-draft", "dl-own"] {
        let row = sender.row(id).await;
        assert_eq!((row.state.as_str(), row.attempts), ("failed", 1), "{id}");
    }
    let mut problems = sender.problems().await;
    problems.sort_by(|a, b| a.0["deliveryId"].as_str().cmp(&b.0["deliveryId"].as_str()));
    assert_eq!(problems[0].0["errorKind"], "user_draft_in_progress");
    assert_eq!(problems[0].1, "You have a review of your own in progress on this pull request");
    assert_eq!(problems[1].0["errorKind"], "not_allowed");
}

#[tokio::test]
async fn a_result_whose_subject_moved_on_goes_back_to_the_user_as_a_draft() {
    let sender = Sender::new();
    sender.queue("dl-1", "github", "pr", "queued", "auto", sender.rig.clock.now_ms()).await;
    sender.channels.stale("new commits");
    sender.pass().await;
    assert!(sender.sent().is_empty());
    assert_eq!(sender.row("dl-1").await.state, "stopped");
    let items = sender.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    assert_eq!(items.iter().map(|item| item.kind.as_str()).collect::<Vec<_>>(), ["draft"]);
    let payload: Value = serde_json::from_str(&items[0].payload).expect("json");
    assert_eq!(payload["staleReason"], "new commits");
    let waits = OutcomeCall::Held { run_id: "rn-1".into(), item_id: items[0].id.clone() };
    assert_eq!(sender.outcomes.calls(), [waits], "the run waits for the user again");
}

impl Sender {
    /// The waiting drafts' subjects and the recipients each goes to.
    async fn drafts(&self) -> Vec<(Option<String>, Vec<String>)> {
        let items = self.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
        let drafts = items.into_iter().filter(|item| item.kind.as_str() == "draft");
        drafts
            .map(|item| {
                let payload: Value = serde_json::from_str(&item.payload).expect("json");
                let targets = payload["targets"].as_array().cloned().unwrap_or_default();
                let mut recipients: Vec<String> =
                    targets.iter().filter_map(|t| t["recipientId"].as_str().map(str::to_owned)).collect();
                recipients.sort();
                (item.subject_key, recipients)
            })
            .collect()
    }
}

#[tokio::test]
async fn every_target_whose_send_went_stale_is_held_again_in_one_draft_about_the_item() {
    let sender = Sender::new();
    sender.rig.temp.exec("UPDATE runs SET item_key = 'github:pr:acme/game#482' WHERE id = 'rn-1'");
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-pr", "github", "pr", "queued", "auto", now).await;
    sender.queue("dl-boss", "github", "boss", "queued", "auto", now).await;
    sender.channels.stale("new commits");
    sender.channels.stale("new commits");
    sender.pass().await;
    let subject = Some("github:pr:acme/game#482".to_owned());
    assert_eq!(sender.drafts().await, [(subject, vec!["boss".to_owned(), "pr".to_owned()])], "no target is lost");
    let ended = sender.outcomes.calls().into_iter().any(|call| matches!(call, OutcomeCall::Finished { .. }));
    assert!(!ended, "a draft its own run holds again does not end the run");
}

#[tokio::test]
async fn a_later_runs_draft_on_the_same_item_replaces_one_held_again() {
    let sender = Sender::new();
    sender.rig.temp.exec("UPDATE runs SET item_key = 'github:pr:acme/game#482' WHERE id = 'rn-1'");
    sender.queue("dl-1", "github", "pr", "queued", "approved", sender.rig.clock.now_ms()).await;
    sender.channels.stale("new commits");
    sender.pass().await;
    let subject = Some("github:pr:acme/game#482".to_owned());
    assert_eq!(sender.drafts().await, [(subject, vec!["pr".to_owned()])], "held again");

    sender.rig.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, item_key, created_at, \
         updated_at) VALUES ('rn-2', 'rt-1', 'standing', 'hand', '{}', 'checking', 0, 'mac-1', \
         'github:pr:acme/game#482', 1, 1)",
    );
    let rig = &sender.rig;
    let gate = Arc::new(Gate::new(Arc::new(sender.channels.clone()), rig.zone.clone(), rig.clock.clone()));
    let (control, outcomes): (Arc<dyn RoutineControl>, Arc<dyn RunOutcomes>) =
        (rig.control.clone(), sender.outcomes.clone());
    gate.attach(&control, &outcomes);
    let (ids, now) = (rig.ids.clone(), rig.clock.now_ms());
    let later = GateInput { run_id: "rn-2".into(), ..input("draft") };
    let decision = rig
        .temp
        .port()
        .write(move |tx, out| gate.apply_in(tx, out, now, ids.as_ref(), &later))
        .await
        .expect("the gate decides");
    assert!(matches!(decision, GateDecision::Held { .. }), "{decision:?}");
    let items = rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    let drafts: Vec<_> =
        items.iter().filter(|item| item.kind.as_str() == "draft").map(|item| item.run_id.clone()).collect();
    assert_eq!(drafts, [Some("rn-2".to_owned())], "one draft about the pull request waits");
    let ended = OutcomeCall::Finished { run_id: "rn-1".into(), outcome: Outcome::Replaced };
    assert!(sender.outcomes.calls().contains(&ended), "the run held again ends replaced");
}

#[tokio::test]
async fn the_loop_sends_what_the_user_sends_and_stops() {
    let gated = Gated::new();
    let channels = gated.channels.clone();
    let control: Arc<dyn RoutineControl> = gated.rig.control.clone();
    let engine = Arc::new(Delivery::new(DeliveryParts {
        store: gated.rig.temp.port(),
        clock: gated.rig.clock.clone(),
        sleeper: Arc::new(FakeSleeper::default()),
        ids: gated.rig.ids.clone(),
        zone: gated.rig.zone.clone(),
        channels: Arc::new(channels.clone()),
        control,
        outcomes: Arc::new(FakeRunOutcomes::new()),
        wake: gated.rig.wake.clone(),
    }));
    engine.start();
    let GateDecision::Held { item_id } = gated.apply(input("draft")).await else { panic!("not held") };
    gated.rig.items.send(&item_id, 1, None, "dashboard", false).await.expect("sent");
    let mut waited = 0;
    while channels.sent().is_empty() && waited < 200 {
        tokio::time::sleep(Duration::from_millis(10)).await;
        waited += 1;
    }
    assert_eq!(channels.sent().len(), 1, "poked by the send");
    engine.stop().await;
}

#[tokio::test]
async fn nothing_is_claimed_while_eos_is_stopped() {
    let sender = Sender::new();
    sender.queue("dl-1", "github", "pr", "queued", "auto", sender.rig.clock.now_ms()).await;
    sender.rig.temp.exec("INSERT INTO inbox_halt (id, \"on\", since, by, updated_at) VALUES (1, 1, 1, 'dashboard', 1)");
    sender.pass().await;
    assert!(sender.sent().is_empty());
    assert_eq!(sender.row("dl-1").await.state, "queued");
}

#[tokio::test]
async fn the_loop_sleeps_until_the_send_that_may_go_next_not_for_one_held_behind_its_target() {
    let sleeper = Arc::new(FakeSleeper::default());
    let sender = Sender::sleeping(pull_requests(), sleeper.clone());
    let now = sender.rig.clock.now_ms();
    // The older send to the target waits on the retry ladder; a newer one
    // to the same target is due, but goes only after it.
    sender.queue("dl-old", "github", "pr", "queued", "auto", now - 10).await;
    sender.rig.temp.exec(&format!(
        "UPDATE inbox_deliveries SET attempts = 1, next_attempt_at = {} WHERE id = 'dl-old'",
        now + 30_000
    ));
    sender.queue("dl-new", "github", "pr", "queued", "auto", now - 5).await;
    sender.engine.start();
    let mut waited = 0;
    while sleeper.pending().is_empty() && waited < 200 {
        tokio::time::sleep(Duration::from_millis(10)).await;
        waited += 1;
    }
    assert_eq!(sleeper.pending(), [30_000], "it waits for the older send's retry");
    assert!(sender.sent().is_empty());
    sender.engine.stop().await;
}

#[tokio::test]
async fn many_sends_held_behind_their_target_never_starve_one_that_may_go() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-0", "github", "pr", "queued", "auto", now - 100).await;
    sender.rig.temp.exec(&format!("UPDATE inbox_deliveries SET next_attempt_at = {} WHERE id = 'dl-0'", now + 30_000));
    for n in 1..=25 {
        sender.queue(&format!("dl-{n}"), "github", "pr", "queued", "auto", now - 100 + n).await;
    }
    sender.queue("dl-other", "github", "boss", "queued", "auto", now).await;
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-other"]);
}
