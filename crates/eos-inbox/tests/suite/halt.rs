//! "Stop everything": the switch freezes every send that has not gone out
//! and the claim takes nothing; resume asks the user about each frozen send
//! and sends nothing by itself; a send frozen by a development run is left.

use std::sync::Arc;

use eos_contracts::{HaltState, InboxAnswer, ProblemChoice};
use eos_core::delivery::{
    Channel, ChannelTraits, Channels, Fresh, Receipt, SendError, SendErrorKind, SendRequest, Target, UndoOutcome,
};
use eos_core::store::{Store, StoredHalt};
use eos_core::{BoxFuture, Clock};
use eos_domain::inbox::ItemKind;
use eos_inbox::HALTED;
use eos_inbox::delivery::{Delivery, DeliveryParts};
use eos_testkit::{FakeChannels, FakeSleeper};

use crate::delivery::{Sender, failure};

#[tokio::test]
async fn halt_freezes_what_has_not_gone_out_and_resume_asks_about_each_without_sending() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-holding", "github", "pr", "holding", "auto", now + 10_000).await;
    sender.queue("dl-queued", "github", "boss", "queued", "auto", now).await;
    sender.queue("dl-out", "github", "me", "sending", "auto", now).await;
    sender.queue("dl-dev", "github", "other", "frozen", "auto", now).await;
    sender.rig.temp.exec("UPDATE inbox_deliveries SET last_error_kind = 'dev_run' WHERE id = 'dl-dev'");

    let on = sender.rig.items.halt("phone").await.expect("halted");
    assert_eq!(on, HaltState { on: true, since: Some(now) });
    assert_eq!(sender.rig.items.halt_state().await.expect("reads"), on);
    for id in ["dl-holding", "dl-queued"] {
        let row = sender.row(id).await;
        assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("frozen", Some(HALTED)), "{id}");
    }
    assert_eq!(sender.row("dl-out").await.state, "sending", "a send on its way finishes");
    sender.rig.clock.advance(60_000);
    sender.pass().await;
    assert!(sender.sent().is_empty());

    let off = sender.rig.items.resume("dashboard").await.expect("resumed");
    assert_eq!(off, HaltState { on: false, since: None });
    sender.pass().await;
    assert!(sender.sent().is_empty(), "nothing goes by itself");
    for id in ["dl-holding", "dl-queued"] {
        let row = sender.row(id).await;
        assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("failed", Some(HALTED)), "{id}");
    }
    let dev = sender.row("dl-dev").await;
    assert_eq!((dev.state.as_str(), dev.last_error_kind.as_deref()), ("frozen", Some("dev_run")));
    let problems = sender.problems().await;
    assert_eq!(problems.len(), 2);
    for (payload, summary) in &problems {
        assert_eq!(summary, "Held when you stopped Eos. Send now?");
        assert_eq!(payload["errorKind"], "internal");
    }

    // Send now goes as any delivery problem's retry does.
    let items = sender.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    let problem = items.iter().find(|item| item.kind == ItemKind::DeliveryProblem).expect("a problem");
    let retry = InboxAnswer::DeliveryProblem { choice: ProblemChoice::Retry, doc: None };
    sender.rig.items.answer(&problem.id, problem.rev, &retry, "dashboard").await.expect("answered");
    sender.pass().await;
    assert_eq!(sender.sent().len(), 1);
}

#[tokio::test]
async fn switching_it_twice_changes_nothing_the_second_time() {
    let sender = Sender::new();
    let first = sender.rig.items.halt("dashboard").await.expect("halted");
    sender.rig.clock.advance(5_000);
    assert_eq!(sender.rig.items.halt("phone").await.expect("halted again"), first, "since stays");
    sender.rig.items.resume("dashboard").await.expect("resumed");
    assert_eq!(sender.rig.items.resume("dashboard").await.expect("still off"), HaltState { on: false, since: None });
}

/// The test's channels, whose send switches halt on while it is on its way.
struct HaltingOnSend {
    channels: FakeChannels,
    store: Arc<dyn Store>,
}

struct HaltingChannel {
    channel: Arc<dyn Channel>,
    store: Arc<dyn Store>,
}

impl Channels for HaltingOnSend {
    fn get(&self, channel: &str) -> Option<Arc<dyn Channel>> {
        let channel = self.channels.get(channel)?;
        Some(Arc::new(HaltingChannel { channel, store: self.store.clone() }))
    }
}

impl Channel for HaltingChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        self.channel.traits(action)
    }

    fn precondition<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        self.channel.precondition(req)
    }

    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        Box::pin(async move {
            let on = StoredHalt { on: true, since: Some(1), by: Some("phone".into()), updated_at: 1 };
            self.store.write(move |tx, _| tx.inbox_halt().put(&on)).await.expect("halted");
            self.channel.send(req).await
        })
    }

    fn lookup<'a>(&'a self, key: &'a str, target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        self.channel.lookup(key, target)
    }

    fn undo<'a>(&'a self, receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        self.channel.undo(receipt)
    }
}

#[tokio::test]
async fn a_send_that_fails_in_passing_while_eos_is_stopped_is_frozen_and_asked_about_on_resume() {
    let sender = Sender::new();
    let rig = &sender.rig;
    let channels = HaltingOnSend { channels: sender.channels.clone(), store: rig.temp.port() };
    let engine = Delivery::new(DeliveryParts {
        store: rig.temp.port(),
        clock: rig.clock.clone(),
        sleeper: Arc::new(FakeSleeper::default()),
        ids: rig.ids.clone(),
        zone: rig.zone.clone(),
        channels: Arc::new(channels),
        control: rig.control.clone(),
        outcomes: sender.outcomes.clone(),
        wake: Arc::new(tokio::sync::Notify::new()),
    });
    sender.queue("dl-1", "github", "pr", "queued", "auto", rig.clock.now_ms()).await;
    sender.channels.script(Err(failure(SendErrorKind::Transient, "rate_limited")));
    engine.pass().await.expect("a pass");
    let row = sender.row("dl-1").await;
    assert_eq!(
        (row.state.as_str(), row.last_error_kind.as_deref()),
        ("frozen", Some(HALTED)),
        "not queued to go again"
    );

    rig.items.resume("dashboard").await.expect("resumed");
    rig.clock.advance(60 * 60 * 1000);
    sender.pass().await;
    assert_eq!(sender.sent(), ["dl-1"], "only the one try before the halt");
    assert_eq!(sender.problems().await.len(), 1);
}

#[tokio::test]
async fn a_send_looked_up_and_not_found_while_eos_is_stopped_is_frozen_not_sent_again() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-lost", "github", "pr", "uncertain", "auto", now).await;
    sender.rig.items.halt("phone").await.expect("halted");
    sender.pass().await;
    let row = sender.row("dl-lost").await;
    assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("frozen", Some(HALTED)));

    sender.rig.items.resume("dashboard").await.expect("resumed");
    sender.pass().await;
    assert!(sender.sent().is_empty(), "nothing goes by itself");
    assert_eq!(sender.problems().await.len(), 1);
}

#[tokio::test]
async fn a_send_waiting_for_its_capability_keeps_waiting_while_eos_is_stopped() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-wait", "github", "pr", "waiting_capability", "auto", now).await;
    sender.rig.items.halt("phone").await.expect("halted");
    sender.pass().await;
    assert_eq!(sender.row("dl-wait").await.state, "waiting_capability");
    assert!(sender.sent().is_empty());
}
