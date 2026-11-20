//! The user's edits of routines' results: read once at start and after each
//! change in Needs you (`inbox:change`), by one task, each new edit a moment
//! for reflection.

use std::sync::Arc;

use eos_core::inbox::ResultEdits;
use eos_core::store::Store;
use eos_core::{Clock, Ids};
use eos_runtime::bus::{Bus, Subscription};
use tokio::sync::Notify;

const INBOX_CHANGE: &str = "inbox:change";

pub(crate) struct EditWatch {
    inner: Arc<Inner>,
    _subscription: Subscription,
}

pub(crate) struct Inner {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    pub(crate) edits: Arc<dyn ResultEdits>,
    /// Set by each change in Needs you.
    changed: Arc<Notify>,
    reflect: Arc<Notify>,
}

impl Inner {
    /// Looks now and after each change, until stopped: one task, so no
    /// edit is kept twice.
    pub(crate) async fn run(self: Arc<Self>) {
        loop {
            self.look().await;
            self.changed.notified().await;
        }
    }

    async fn look(&self) {
        match eos_memory::edits::capture(&self.store, self.clock.as_ref(), self.ids.as_ref(), self.edits.as_ref()).await
        {
            Ok(0) => {}
            Ok(kept) => {
                tracing::info!(moments = kept, "memory: captured edits");
                self.reflect.notify_one();
            }
            Err(e) => tracing::warn!(error = %e, "memory: the edits were not read"),
        }
    }
}

impl EditWatch {
    pub(crate) fn new(
        bus: &Bus,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        edits: Arc<dyn ResultEdits>,
        reflect: Arc<Notify>,
    ) -> Self {
        let changed = Arc::new(Notify::new());
        let inner = Arc::new(Inner { store, clock, ids, edits, changed: changed.clone(), reflect });
        let subscription = bus.on(INBOX_CHANGE, move |_event| changed.notify_one());
        Self { inner, _subscription: subscription }
    }

    pub(crate) fn inner(&self) -> Arc<Inner> {
        self.inner.clone()
    }
}
