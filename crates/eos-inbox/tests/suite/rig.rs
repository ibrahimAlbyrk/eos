//! A store, a clock, ids and the ports items are opened with.

use std::sync::Arc;

use eos_core::Clock;
use eos_core::store::StoredItem;
use eos_domain::inbox::ItemKind;
use eos_inbox::{Items, NewItem, Opening, open_in};
use eos_testkit::{FakeClock, FakeRoutineControl, FakeTimeZone, SeqIds, TempStore};
use serde_json::json;

pub(crate) struct Rig {
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) ids: Arc<SeqIds>,
    pub(crate) zone: Arc<FakeTimeZone>,
    pub(crate) control: Arc<FakeRoutineControl>,
    pub(crate) items: Items,
}

impl Rig {
    pub(crate) fn new() -> Self {
        Self::on(TempStore::new())
    }

    /// Over a store that already exists: the app after a restart.
    pub(crate) fn on(temp: TempStore) -> Self {
        let clock = Arc::new(FakeClock::at(1_000_000));
        let items = Items::new(temp.port(), clock.clone());
        Self {
            temp,
            clock,
            ids: Arc::new(SeqIds::new()),
            zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
            control: Arc::new(FakeRoutineControl::new()),
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
