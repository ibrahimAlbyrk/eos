//! A store, a clock, ids and the ports items are opened with.

use std::sync::Arc;

use eos_core::Clock;
use eos_core::routine::Confirmed;
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
        Self::build(temp, FakeChannels::new(), Arc::default(), pull_requests())
    }

    /// Over `temp`, sending drafts through `channels`, to what the user
    /// confirmed of `rt-1`.
    pub(crate) fn with_channels(temp: TempStore, channels: FakeChannels, confirmed: Confirmed) -> Self {
        Self::build(temp, channels, Arc::default(), confirmed)
    }

    /// Over `temp`, waking the run askers `waiters` holds.
    pub(crate) fn with_waiters(temp: TempStore, waiters: Arc<QuestionWaiters>) -> Self {
        Self::build(temp, FakeChannels::new(), waiters, pull_requests())
    }

    fn build(temp: TempStore, channels: FakeChannels, waiters: Arc<QuestionWaiters>, confirmed: Confirmed) -> Self {
        let clock = Arc::new(FakeClock::at(1_000_000));
        let ids = Arc::new(SeqIds::new());
        let outcomes = Arc::new(FakeRunOutcomes::new());
        let wake = Arc::new(tokio::sync::Notify::new());
        let control = Arc::new(FakeRoutineControl::new().confirming("rt-1", confirmed));
        let zone = Arc::new(FakeTimeZone::new("Europe/Istanbul", 180));
        let items = Items::new(ItemsParts {
            store: temp.port(),
            clock: clock.clone(),
            ids: ids.clone(),
            zone: zone.clone(),
            channels: Arc::new(channels),
            outcomes: outcomes.clone(),
            control: control.clone(),
            wake: wake.clone(),
            waiters,
        });
        Self { temp, clock, ids, zone, control, outcomes, wake, items }
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

/// What the user confirmed of routine `rt-1`: a review on its pull request.
pub(crate) fn pull_requests() -> Confirmed {
    let freedom = serde_json::from_value(json!({"rung": "draft"})).expect("a freedom");
    Confirmed { freedom, goes_to: vec![crate::gate::pull_request()] }
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
