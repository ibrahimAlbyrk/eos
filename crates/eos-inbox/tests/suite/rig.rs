//! A store, a clock, ids and the ports items are opened with.

use std::sync::Arc;

use eos_core::Clock;
use eos_core::store::StoredItem;
use eos_domain::inbox::ItemKind;
use eos_inbox::{Items, ItemsParts, NewItem, Opening, QuestionWaiters, open_in};
use eos_testkit::{FakeChannels, FakeClock, FakeRoutineControl, FakeRunOutcomes, FakeTimeZone, SeqIds, TempStore};
use serde_json::json;

pub(crate) struct Rig {
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) ids: Arc<SeqIds>,
    pub(crate) zone: Arc<FakeTimeZone>,
    pub(crate) control: Arc<FakeRoutineControl>,
    pub(crate) outcomes: Arc<FakeRunOutcomes>,
    pub(crate) wake: Arc<tokio::sync::Notify>,
    pub(crate) items: Items,
}

impl Rig {
    pub(crate) fn new() -> Self {
        Self::on(TempStore::new())
    }

    /// Over a store that already exists: the app after a restart.
    pub(crate) fn on(temp: TempStore) -> Self {
        Self::build(temp, FakeChannels::new(), Arc::default())
    }

    /// Over `temp`, sending drafts through `channels`.
    pub(crate) fn with_channels(temp: TempStore, channels: FakeChannels) -> Self {
        Self::build(temp, channels, Arc::default())
    }

    /// Over `temp`, waking the run askers `waiters` holds.
    pub(crate) fn with_waiters(temp: TempStore, waiters: Arc<QuestionWaiters>) -> Self {
        Self::build(temp, FakeChannels::new(), waiters)
    }

    fn build(temp: TempStore, channels: FakeChannels, waiters: Arc<QuestionWaiters>) -> Self {
        let clock = Arc::new(FakeClock::at(1_000_000));
        let ids = Arc::new(SeqIds::new());
        let outcomes = Arc::new(FakeRunOutcomes::new());
        let wake = Arc::new(tokio::sync::Notify::new());
        let items = Items::new(ItemsParts {
            store: temp.port(),
            clock: clock.clone(),
            ids: ids.clone(),
            channels: Arc::new(channels),
            outcomes: outcomes.clone(),
            wake: wake.clone(),
            waiters,
        });
        Self {
            temp,
            clock,
            ids,
            zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
            control: Arc::new(FakeRoutineControl::new()),
            outcomes,
            wake,
            items,
        }
    }

    /// Opens `new` in a write job of its own, as a producer would in its.
    pub(crate) async fn open(&self, new: NewItem) -> StoredItem {
        let (ids, zone, control, now) =
            (self.ids.clone(), self.zone.clone(), self.control.clone(), self.clock.now_ms());
        self.temp
            .port()
            .write(move |tx, out| {
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                open_in(tx, out, &at, new)
            })
            .await
            .expect("the item opens")
    }

    pub(crate) async fn find(&self, id: &str) -> StoredItem {
        let id = id.to_owned();
        let found = self.temp.port().read(move |tx| tx.inbox_items().find(&id)).await.expect("reads");
        found.expect("the item")
    }
}

/// An item of `kind` for routine `rt-1` about `subject`.
pub(crate) fn new_item(kind: ItemKind, subject: Option<&str>) -> NewItem {
    NewItem {
        kind,
        producer: "routines".into(),
        routine_id: Some("rt-1".into()),
        run_id: Some("rn-1".into()),
        subject_key: subject.map(str::to_owned),
        title: "Review of #482".into(),
        summary: "Two comments".into(),
        payload: json!({ "doc": {} }),
        by_hand: false,
    }
}
