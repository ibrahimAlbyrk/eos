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
//! - `GET /api/inbox/deliveries/:id`: one delivery and where it stands.
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
//! it reads the topic by name.

mod project;
mod routes;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{DeliveryChange, InboxChange, SignalSubject};
use eos_core::agent::OpenQuestions;
use eos_core::profile::UserMemoryReader;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock};
use eos_inbox::delivery::{Delivery, DeliveryParts};
use eos_inbox::{Items, ItemsParts, QuestionWaiters};
use eos_runtime::bus::{Bus, RecvError, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;

pub const INBOX_CHANGE: Topic<InboxChange> = Topic::new(eos_inbox::INBOX_CHANGE);
pub const INBOX_DELIVERY: Topic<DeliveryChange> = Topic::new(eos_inbox::INBOX_DELIVERY);
/// The signals feature's: a new version of a subject came in, or it closed.
const SIGNALS_SUBJECT: Topic<SignalSubject> = Topic::new("signals:subject");
/// The subject events that may wait to be acted on.
const SUBJECTS_QUEUED: usize = 256;

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
}

impl std::fmt::Debug for InboxParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboxParts").finish_non_exhaustive()
    }
}

pub struct InboxModule {
    parts: Arc<Shared>,
    delivery: Arc<Delivery>,
    bus: Bus,
    /// Acts on subject events, one at a time in the order they came.
    subjects: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// What every route holds.
pub(crate) struct Shared {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) items: Items,
    pub(crate) questions: Arc<dyn OpenQuestions>,
    pub(crate) memories: Arc<dyn UserMemoryReader>,
}

impl std::fmt::Debug for InboxModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboxModule").finish_non_exhaustive()
    }
}

impl InboxModule {
    pub fn new(parts: InboxParts) -> Self {
        let InboxParts { store, clock, bus, questions, memories, waiters, delivery } = parts;
        let items = Items::new(ItemsParts {
            store: store.clone(),
            clock,
            ids: delivery.ids.clone(),
            channels: delivery.channels.clone(),
            outcomes: delivery.outcomes.clone(),
            control: delivery.control.clone(),
            wake: delivery.wake.clone(),
            waiters,
        });
        Self {
            parts: Arc::new(Shared { store, items, questions, memories }),
            delivery: Arc::new(Delivery::new(delivery)),
            bus,
            subjects: Mutex::new(None),
        }
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
        let previous = self.subjects.lock().unwrap_or_else(PoisonError::into_inner).replace(task);
        if let Some(previous) = previous {
            previous.abort();
        }
    }
}

impl Module for InboxModule {
    fn id(&self) -> &'static str {
        "inbox"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![INBOX_CHANGE.decl(), INBOX_DELIVERY.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.parts)
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        self.delivery.start();
        self.hear_subjects();
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let subjects = self.subjects.lock().unwrap_or_else(PoisonError::into_inner).take();
            if let Some(task) = subjects {
                task.abort();
                let _ = task.await;
            }
            self.delivery.stop().await;
        })
    }
}
