//! Needs you: what waits for the user, over the items of `eos_inbox`.
//!
//! - `GET /api/inbox?state=&routineId=&cursor=`: one page of 100 items in
//!   Needs you's order (open before later, the loudest first, then the
//!   newest), the counts of everything that waits, and `agentsWaiting`: the
//!   open asks and questions of Agents chats, shown as one line, not items;
//! - `GET /api/inbox/:id`: one item with what its kind carries;
//! - `PUT /api/inbox/:id/draft {rev, doc}`: the user's edits of a draft;
//! - `POST /api/inbox/:id/later {until?}` and `…/discard {rev}`;
//! - `POST /api/inbox/:id/answer {rev, answer}`: an answer of the item's
//!   kind; a run's question is answered to its waiting asker;
//! - `POST /api/inbox/:id/send {rev, doc?, confirmStale?}`: sends a held
//!   draft, one delivery per target (`{deliveries: [{id, state, sendAt}]}`);
//! - `GET /api/inbox/deliveries/:id`: one delivery and where it stands;
//! - `GET /api/eos/halt`, `POST /api/eos/halt`, `POST /api/eos/resume`:
//!   "Stop everything" on this Mac, announced on `inbox:halt`.
//!
//! A routine run's permission asks (`perm:<pending id>`) and the memory
//! suggestions about the user (`sugg:<memory id>`) are listed among the items
//! without being copied into them; each is answered through its own recorded
//! route, which a write here names in its 409.
//!
//! Every route answers the user's text, so only the user's dashboard and
//! phone reach them. Writes are announced on `inbox:change`.
//!
//! From `after_ready` to `stop` the module runs the delivery engine
//! ([`Delivery`]), which sends what the gate and the user let go and
//! announces each move of a delivery on `inbox:delivery`, and hears
//! `signals:subject`: a subject that moved on flags its drafts stale, one
//! that closed expires its items. It never depends on the signals feature:
//! it reads the topic by name. A sweeper expires items whose time ran out,
//! brings back the ones put off and deletes those that ended 90 days ago.
//!
//! Attention (`GET`/`PUT /api/settings/attention`): on every `inbox:change`
//! the Dock badge shows the open count and what may interrupt does
//! ([`Notifier`](eos_inbox::attention::Notifier)); the same task wakes at
//! each digest time.

mod project;
mod routes;

use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::Notify;

use eos_contracts::{DeliveryChange, HaltState, InboxChange, SignalSubject};
use eos_core::agent::OpenQuestions;
use eos_core::net::relay::PhoneNotify;
use eos_core::os::DockBadge;
use eos_core::profile::UserMemoryReader;
use eos_core::store::{ConfigSource, Store};
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_inbox::attention::{Notifier, NotifierParts};
use eos_inbox::delivery::{Delivery, DeliveryParts};
use eos_inbox::{Items, ItemsParts, QuestionWaiters};
use eos_runtime::bus::{Bus, RecvError, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;

pub const INBOX_CHANGE: Topic<InboxChange> = Topic::new(eos_inbox::INBOX_CHANGE);
pub const INBOX_DELIVERY: Topic<DeliveryChange> = Topic::new(eos_inbox::INBOX_DELIVERY);
pub const INBOX_HALT: Topic<HaltState> = Topic::new(eos_inbox::INBOX_HALT);
/// The signals feature's: a new version of a subject came in, or it closed.
const SIGNALS_SUBJECT: Topic<SignalSubject> = Topic::new("signals:subject");
/// The subject events that may wait to be acted on.
const SUBJECTS_QUEUED: usize = 256;
/// The changes that may wait to be acted on by attention; a missed one is
/// caught up by the next.
const CHANGES_QUEUED: usize = 256;
/// The longest the sweeper sleeps: its retention pass runs at least hourly.
const SWEEP_EVERY_MS: i64 = 60 * 60 * 1000;

/// What the module is built from.
pub struct InboxParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    /// Where `signals:subject` is heard.
    pub bus: Bus,
    /// The questions agents wait on.
    pub questions: Arc<dyn OpenQuestions>,
    /// The memories, the suggestions about the user among them.
    pub memories: Arc<dyn UserMemoryReader>,
    /// The run askers waiting on their questions
    /// ([`RunQuestions::waiters`](eos_inbox::RunQuestions::waiters)).
    pub waiters: Arc<QuestionWaiters>,
    /// What the delivery engine sends with, and a sent draft is queued with.
    pub delivery: DeliveryParts,
    /// `config.json`, for its `attention` section.
    pub config: Arc<dyn ConfigSource>,
    /// Wakes the user's phone when an item interrupts.
    pub phone: Arc<dyn PhoneNotify>,
    /// The number on the Dock icon.
    pub badge: Arc<dyn DockBadge>,
}

impl std::fmt::Debug for InboxParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboxParts").finish_non_exhaustive()
    }
}

pub struct InboxModule {
    parts: Arc<Shared>,
    delivery: Arc<Delivery>,
    notifier: Notifier,
    bus: Bus,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    /// What runs from `after_ready` to `stop`: the subject listener, which
    /// acts on subject events one at a time in the order they came, and the
    /// sweeper.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// What every route holds.
pub(crate) struct Shared {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) items: Items,
    pub(crate) questions: Arc<dyn OpenQuestions>,
    pub(crate) memories: Arc<dyn UserMemoryReader>,
    pub(crate) config: Arc<dyn ConfigSource>,
    /// Poked when the attention settings changed.
    pub(crate) attention_changed: Arc<Notify>,
}

impl std::fmt::Debug for InboxModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboxModule").finish_non_exhaustive()
    }
}

impl InboxModule {
    pub fn new(parts: InboxParts) -> Self {
        let InboxParts { store, clock, bus, questions, memories, waiters, delivery, config, phone, badge } = parts;
        let sleeper = delivery.sleeper.clone();
        let notifier = Notifier::new(NotifierParts {
            store: store.clone(),
            clock: clock.clone(),
            zone: delivery.zone.clone(),
            config: config.clone(),
            phone,
            badge,
        });
        let items = Items::new(ItemsParts {
            store: store.clone(),
            clock: clock.clone(),
            ids: delivery.ids.clone(),
            zone: delivery.zone.clone(),
            channels: delivery.channels.clone(),
            outcomes: delivery.outcomes.clone(),
            control: delivery.control.clone(),
            wake: delivery.wake.clone(),
            waiters,
        });
        Self {
            parts: Arc::new(Shared {
                store,
                items,
                questions,
                memories,
                config,
                attention_changed: Arc::new(Notify::new()),
            }),
            delivery: Arc::new(Delivery::new(delivery)),
            notifier,
            bus,
            clock,
            sleeper,
            tasks: Mutex::new(Vec::new()),
        }
    }

    fn keep(&self, task: tokio::task::JoinHandle<()>) {
        self.tasks.lock().unwrap_or_else(PoisonError::into_inner).push(task);
    }

    /// From now on, items expire and come back at their times, and those
    /// that ended long ago are deleted, at least once an hour.
    fn sweep(&self) {
        let (items, clock, sleeper) = (self.parts.items.clone(), self.clock.clone(), self.sleeper.clone());
        self.keep(tokio::spawn(async move {
            loop {
                let next = match items.sweep().await {
                    Ok(next) => next,
                    Err(error) => {
                        tracing::warn!(%error, "a sweep failed");
                        None
                    }
                };
                let wait = next.map_or(SWEEP_EVERY_MS, |at| (at - clock.now_ms()).clamp(0, SWEEP_EVERY_MS));
                sleeper.sleep(wait).await;
            }
        }));
    }

    /// From now on, the badge follows the open count, items interrupt as the
    /// settings let them, and digests come at their times. One task, so two
    /// passes never run at once.
    fn attend(&self) {
        let mut changes = self.bus.subscribe(&INBOX_CHANGE, CHANGES_QUEUED);
        let (notifier, store) = (self.notifier.clone(), self.parts.store.clone());
        let (settings, clock, sleeper) =
            (self.parts.attention_changed.clone(), self.clock.clone(), self.sleeper.clone());
        self.keep(tokio::spawn(async move {
            match store.read(|tx| tx.inbox_items().open_count()).await {
                Ok(open) => notifier.badge(open),
                Err(error) => tracing::warn!(%error, "the open count could not be read"),
            }
            loop {
                let next = match notifier.pass().await {
                    Ok(next) => next,
                    Err(error) => {
                        tracing::warn!(%error, "an attention pass failed");
                        clock.now_ms() + SWEEP_EVERY_MS
                    }
                };
                let wait = (next - clock.now_ms()).clamp(0, SWEEP_EVERY_MS);
                tokio::select! {
                    () = sleeper.sleep(wait) => {}
                    () = settings.notified() => notifier.settings_changed(),
                    change = changes.recv() => match change {
                        Ok(event) => {
                            if let Ok(change) = event.payload_as::<InboxChange>() {
                                notifier.badge(change.open);
                            }
                        }
                        Err(RecvError::Lagged(missed)) => tracing::debug!(missed, "inbox changes were missed"),
                        Err(RecvError::Closed) => return,
                    },
                }
            }
        }));
    }

    /// From now on, each subject event is acted on in a write job of its own.
    fn hear_subjects(&self) {
        let mut events = self.bus.subscribe(&SIGNALS_SUBJECT, SUBJECTS_QUEUED);
        let items = self.parts.items.clone();
        let task = tokio::spawn(async move {
            loop {
                let change = match events.recv().await {
                    Ok(event) => event.payload_as::<SignalSubject>(),
                    // A missed event leaves a draft unflagged; the send's own
                    // freshness check still holds it back.
                    Err(RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, "subject events were missed");
                        continue;
                    }
                    Err(RecvError::Closed) => return,
                };
                let Ok(change) = change else { continue };
                if let Err(error) = items.subject(change).await {
                    tracing::warn!(%error, "a subject event could not be acted on");
                }
            }
        });
        self.keep(task);
    }
}

impl Module for InboxModule {
    fn id(&self) -> &'static str {
        "inbox"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![INBOX_CHANGE.decl(), INBOX_DELIVERY.decl(), INBOX_HALT.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.parts)
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        self.delivery.start();
        self.hear_subjects();
        self.sweep();
        self.attend();
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(PoisonError::into_inner));
            for task in tasks {
                task.abort();
                let _ = task.await;
            }
            self.delivery.stop().await;
        })
    }
}
