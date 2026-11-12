//! Dreaming (`manager/modules/dreams`; Settings › Profile, off by default):
//! overnight a model rereads the finished chats and proposes memory changes
//! for the user to keep or dismiss.
//!
//! [`Dreams`] decides when and keeps one dream at a time; `run` is one dream;
//! [`rules`] and [`ledger`] are its pure parts. Every model request goes
//! through the one-shot port.

pub mod ledger;
pub mod prompt_data;
mod routes;
pub mod rules;
mod run;
mod service;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::DreamChangeEvent;
use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_core::Sleeper;
use eos_core::accounts::PlanAccess;
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::jobs::JobRegistry;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use serde_json::Value;

pub use run::{DreamParts, dream_over_chats};
pub use service::Dreams;

/// A dream started, moved on, or finished: the Memory view, Settings and the
/// dream log read its status again.
pub const DREAM_CHANGE: Topic<DreamChangeEvent> = Topic::new("dream:change");

/// The kind of a dream's row in the Jobs tab.
pub const JOB_KIND: &str = "dream";

/// How often the schedule is looked at.
const TICK_MS: i64 = 60_000;

pub struct DreamsModule {
    dreams: Dreams,
    store: Arc<dyn eos_core::store::Store>,
    bus: Bus,
    sleeper: Arc<dyn Sleeper>,
    stopped: Arc<AtomicBool>,
    activity: Mutex<Option<Subscription>>,
}

impl std::fmt::Debug for DreamsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DreamsModule").field("dreams", &self.dreams).finish_non_exhaustive()
    }
}

impl DreamsModule {
    pub fn new(
        parts: DreamParts,
        plan: Arc<dyn PlanAccess>,
        bus: Bus,
        jobs: JobRegistry,
        sleeper: Arc<dyn Sleeper>,
    ) -> Self {
        let store = parts.store.clone();
        let dreams = Dreams::new(parts, plan, bus.clone(), jobs);
        Self { dreams, store, bus, sleeper, stopped: Arc::default(), activity: Mutex::default() }
    }

    pub fn dreams(&self) -> &Dreams {
        &self.dreams
    }
}

impl Module for DreamsModule {
    fn id(&self) -> &'static str {
        "dreams"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.dreams, &self.store)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![DREAM_CHANGE.decl()]
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![JOB_KIND]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            let tasks = tokio::runtime::Handle::current();
            // A top-level chat starting work means the user is here: a
            // scheduled dream stops after its current chat, and "away"
            // starts counting again.
            let (dreams, store, spawner) = (self.dreams.clone(), self.store.clone(), tasks.clone());
            let activity = self.bus.on(WORKER_CHANGE, move |event| {
                let Ok(change) = event.payload_as::<Value>() else { return };
                let Some(worker) = change["workerId"].as_str().filter(|_| change["state"] == "WORKING") else { return };
                let (dreams, store, worker) = (dreams.clone(), store.clone(), worker.to_owned());
                spawner.spawn(async move {
                    let row = store.read(move |tx| tx.workers().find(&worker)).await;
                    if row.is_ok_and(|row| row.is_some_and(|row| row.parent_id.is_none())) {
                        dreams.note_user_activity();
                    }
                });
            });
            *self.activity.lock().unwrap_or_else(PoisonError::into_inner) = Some(activity);
            let (dreams, sleeper, stopped) = (self.dreams.clone(), self.sleeper.clone(), self.stopped.clone());
            tasks.spawn(async move {
                loop {
                    sleeper.sleep(TICK_MS).await;
                    if stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    dreams.tick().await;
                }
            });
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.stopped.store(true, Ordering::SeqCst);
            self.activity.lock().unwrap_or_else(PoisonError::into_inner).take();
        })
    }
}
