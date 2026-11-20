//! The channels a run's results go out through, off the network: each
//! still says what its actions are, so the gate decides as it would, and
//! every call that would reach the service answers `DevRun`. The delivery
//! engine freezes the row then; nothing is sent.

use std::sync::Arc;

use eos_core::BoxFuture;
use eos_core::delivery::{
    Channel, ChannelTraits, Channels, Fresh, Receipt, SendError, SendErrorKind, SendRequest, Target, UndoOutcome,
};

pub(super) struct OffChannels(pub(super) Arc<dyn Channels>);

impl Channels for OffChannels {
    fn get(&self, channel: &str) -> Option<Arc<dyn Channel>> {
        self.0.get(channel).map(|channel| Arc::new(OffChannel(channel)) as Arc<dyn Channel>)
    }
}

struct OffChannel(Arc<dyn Channel>);

fn dev_run<T: Send + 'static>() -> BoxFuture<'static, Result<T, SendError>> {
    Box::pin(std::future::ready(Err(SendError { kind: SendErrorKind::DevRun, detail_kind: "dev_run".to_owned() })))
}

impl Channel for OffChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        self.0.traits(action)
    }

    fn precondition<'a>(&'a self, _req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        dev_run()
    }

    fn send<'a>(&'a self, _req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        dev_run()
    }

    fn lookup<'a>(&'a self, _key: &'a str, _target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        dev_run()
    }

    fn undo<'a>(&'a self, _receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        dev_run()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use eos_contracts::{ActionClass, ResultDoc};
    use eos_core::delivery::{ChannelTraits, Idempotency, Undo};
    use eos_core::routine::RoutineControl;
    use eos_core::store::StoredDelivery;
    use eos_inbox::delivery::{Delivery, DeliveryParts};
    use eos_testkit::{
        FakeChannels, FakeClock, FakeRoutineControl, FakeRunOutcomes, FakeSleeper, FakeTimeZone, SeqIds, TempStore,
    };
    use serde_json::json;

    use crate::reach::Reach;

    #[tokio::test]
    async fn off_the_network_a_send_freezes_as_a_dev_run_and_no_channel_is_called() {
        let traits = ChannelTraits {
            class: ActionClass::Speak,
            idempotency: Idempotency::Marker,
            undo: Undo::Partial,
            undo_window_ms: 0,
            max_bytes: 65_536,
        };
        let channels = FakeChannels::new().with("github", traits);
        let off = Reach::new(false).channels(Arc::new(channels.clone()));
        let github = off.get("github").expect("still listed");
        assert_eq!(github.traits("post_review"), Some(traits), "the gate decides as it would");

        let temp = TempStore::new();
        let doc = ResultDoc {
            kind: "github.review".into(),
            channel: "github".into(),
            action: "post_review".into(),
            parts: vec![],
        };
        let row = StoredDelivery {
            id: "dl-1".into(),
            item_id: None,
            run_id: "rn-1".into(),
            routine_id: "rt-1".into(),
            channel: "github".into(),
            action: "post_review".into(),
            target_ref: "pr".into(),
            target: json!({"recipientId": "pr", "place": {"item": "github:pr:acme/game#482"}}).to_string(),
            body: serde_json::to_string(&doc).expect("json"),
            body_hash: "h".into(),
            class: ActionClass::Speak,
            mode: "auto".into(),
            state: "queued".into(),
            send_at: Some(0),
            attempts: 0,
            next_attempt_at: Some(0),
            last_error_kind: None,
            partial: None,
            receipt: None,
            sent_at: None,
            undo_until: None,
            undone_at: None,
            approved_at: None,
            created_at: 0,
            updated_at: 0,
        };
        temp.port().write(move |tx, _| tx.inbox_deliveries().insert(&row)).await.expect("queued");
        let control: Arc<dyn RoutineControl> = Arc::new(FakeRoutineControl::new());
        let engine = Delivery::new(DeliveryParts {
            store: temp.port(),
            clock: Arc::new(FakeClock::at(1_000)),
            sleeper: Arc::new(FakeSleeper::default()),
            ids: Arc::new(SeqIds::new()),
            zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
            channels: off,
            control,
            outcomes: Arc::new(FakeRunOutcomes::new()),
            wake: Arc::new(tokio::sync::Notify::new()),
        });
        engine.pass().await.expect("a pass");

        let row = temp.port().read(|tx| tx.inbox_deliveries().find("dl-1")).await.expect("reads").expect("a row");
        assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("frozen", Some("dev_run")));
        assert!(channels.sent().is_empty(), "the channel was never called");
    }
}
