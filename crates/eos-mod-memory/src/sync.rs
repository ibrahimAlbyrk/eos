//! Memory's face to the sync feature ([`ExperienceSync`]): its notes and
//! this Mac's counters as records (`eos_memory::sync`). A pass after the
//! first reads only the notes changed since; this Mac's counters go out at
//! most every [`COUNTERS_EVERY_MS`]. Once memory's records fill
//! [`OLD_EPISODE_TEXT_DROP`] of its vault share, old closed episodes travel
//! without their text (D26), as the last whole listing found.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::experience::ExperienceSync;
use eos_core::net::sync::Changed;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error};
use eos_domain::sync::SyncItem;
use eos_memory::sync::{
    OLD_EPISODE_TEXT_DROP, Travel, apply_in, counter_items_in, item_in, merge, note_ids_in, note_items_in, remove_in,
};
use eos_sync::EXPERIENCE_BUDGET;
use serde_json::Value;

/// This Mac's counters travel at most this often.
pub(crate) const COUNTERS_EVERY_MS: i64 = 6 * 60 * 60 * 1000;

pub(crate) struct Experience {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    device: String,
    drop_old_text: AtomicBool,
    /// This Mac's counter records as last sent, and when they were read.
    counters: Mutex<Option<(i64, Vec<SyncItem>)>>,
}

impl Experience {
    pub(crate) fn new(store: Arc<dyn Store>, clock: Arc<dyn Clock>, device: String) -> Self {
        Self { store, clock, device, drop_old_text: AtomicBool::new(false), counters: Mutex::default() }
    }

    fn travel(&self) -> Travel {
        Travel { now: self.clock.now_ms(), drop_old_text: self.drop_old_text.load(Ordering::SeqCst) }
    }

    /// This Mac's counters, read again when `fresh` or when they are older
    /// than [`COUNTERS_EVERY_MS`]; whether they were read again.
    async fn counters(&self, fresh: bool) -> Result<(Vec<SyncItem>, bool), Error> {
        let now = self.clock.now_ms();
        let cached = self.counters.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some((_, items)) = cached.filter(|(at, _)| !fresh && now - at < COUNTERS_EVERY_MS) {
            return Ok((items, false));
        }
        let device = self.device.clone();
        let items = self.store.read(move |tx| counter_items_in(tx, &device)).await?;
        *self.counters.lock().unwrap_or_else(PoisonError::into_inner) = Some((now, items.clone()));
        Ok((items, true))
    }
}

/// The bytes the records take, roughly as they travel.
fn size(items: &[SyncItem]) -> u64 {
    items.iter().map(|item| item.data.to_string().len() as u64).sum()
}

impl ExperienceSync for Experience {
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(async move {
            let whole = Travel { drop_old_text: false, ..self.travel() };
            let mut notes = self.store.read(move |tx| note_items_in(tx, 0, whole)).await?;
            let crowded = size(&notes) as f64 > OLD_EPISODE_TEXT_DROP * EXPERIENCE_BUDGET as f64;
            self.drop_old_text.store(crowded, Ordering::SeqCst);
            if crowded {
                tracing::info!("memory: old episodes travel without their text");
                let travel = self.travel();
                notes = self.store.read(move |tx| note_items_in(tx, 0, travel)).await?;
            }
            notes.extend(self.counters(true).await?.0);
            Ok(notes)
        })
    }

    fn changed_since(&self, since_ms: i64) -> BoxFuture<'_, Result<Changed, Error>> {
        Box::pin(async move {
            let travel = self.travel();
            let (mut items, ids) =
                self.store.read(move |tx| Ok((note_items_in(tx, since_ms, travel)?, note_ids_in(tx)?))).await?;
            let (counters, read) = self.counters(false).await?;
            let mut ids: Vec<String> = ids;
            ids.extend(counters.iter().map(|item| item.id.clone()));
            if read {
                items.extend(counters);
            }
            Ok(Changed { items, ids })
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        let (device, id, travel) = (self.device.clone(), id.to_owned(), self.travel());
        Box::pin(self.store.read(move |tx| item_in(tx, &device, &id, travel)))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        let (device, id, data) = (self.device.clone(), id.to_owned(), data.clone());
        Box::pin(self.store.write(move |tx, out| apply_in(tx, out, &device, &id, &data)))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let id = id.to_owned();
        Box::pin(self.store.write(move |tx, out| remove_in(tx, out, &id)))
    }

    fn merge(&self, local: &Value, remote: &Value) -> Option<Value> {
        merge(local, remote)
    }
}
