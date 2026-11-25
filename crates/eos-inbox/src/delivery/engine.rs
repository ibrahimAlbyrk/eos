//! The delivery engine (03 §4.8 "Engine", G5, G19): one loop for the app's
//! life, on the [`Clock`] and the [`Sleeper`]. It wakes at the earliest due
//! time the table holds, or when poked (the gate queued a send). Each pass
//! looks up the sends whose outcome is unknown, claims what may go in one
//! write job, and calls each channel off the writer thread, then records
//! what it answered in a job of its own: a crash between the two leaves the
//! row `sending`, which the next launch turns `uncertain`.
//!
//! Only ids, states, attempts and error kinds reach the log; bodies,
//! targets and receipts never do.

use std::sync::{Arc, Mutex};

use eos_core::delivery::{Channels, Fresh, SendError, SendErrorKind, SendRequest};
use eos_core::os::TimeZone;
use eos_core::routine::{RoutineControl, RunOutcomes};
use eos_core::store::{Store, StoredDelivery};
use eos_core::{Clock, Error, Ids, Sleeper};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::claim::{claim_in, next_due_in, resume_in};
use super::reconcile::{Found, found, launch_in, settle_in};
use super::record::{Attempt, record_in};
use super::{UNCERTAIN, target_of};
use crate::Opening;

/// The longest the loop sleeps with nothing due: a row written by another
/// path that did not poke is still sent.
const IDLE_MS: i64 = 10 * 60 * 1000;
/// How long the loop waits after a pass failed.
const AFTER_ERROR_MS: i64 = 30_000;

/// What the engine is built from.
pub struct DeliveryParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    pub ids: Arc<dyn Ids>,
    /// The user's clock, for the times a problem names.
    pub zone: Arc<dyn TimeZone>,
    pub channels: Arc<dyn Channels>,
    /// Pauses a routine with too many items waiting, when a problem opens.
    pub control: Arc<dyn RoutineControl>,
    /// Hears what became of each run's result.
    pub outcomes: Arc<dyn RunOutcomes>,
    /// Poked when a send was queued ([`Gate::waker`](crate::gate::Gate::waker)).
    pub wake: Arc<Notify>,
}

impl std::fmt::Debug for DeliveryParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeliveryParts").finish_non_exhaustive()
    }
}

pub struct Delivery {
    parts: DeliveryParts,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for Delivery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Delivery").finish_non_exhaustive()
    }
}

/// One channel call's request, from the row the gate checked.
fn request(row: &StoredDelivery) -> Option<SendRequest> {
    Some(SendRequest {
        key: row.id.clone(),
        run_id: row.run_id.clone(),
        channel: row.channel.clone(),
        action: row.action.clone(),
        target: target_of(&row.target)?,
        body: serde_json::from_str(&row.body).ok()?,
    })
}

impl Delivery {
    pub fn new(parts: DeliveryParts) -> Self {
        Self { parts, task: Mutex::new(None) }
    }

    /// Starts the loop; the first pass looks up what a crash left sending.
    pub fn start(self: &Arc<Self>) {
        let engine = self.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = engine.launch().await {
                tracing::warn!(%error, "interrupted sends could not be marked");
            }
            loop {
                let wait = match engine.pass().await {
                    Ok(()) => engine.next_wait().await,
                    Err(error) => {
                        tracing::warn!(%error, "a delivery pass failed");
                        AFTER_ERROR_MS
                    }
                };
                tokio::select! {
                    () = engine.parts.sleeper.sleep(wait) => {}
                    () = engine.parts.wake.notified() => {}
                }
            }
        });
        if let Some(previous) = self.task.lock().unwrap_or_else(|p| p.into_inner()).replace(task) {
            previous.abort();
        }
    }

    /// Ends the loop; a send in flight is dropped and found again at the
    /// next launch.
    pub async fn stop(&self) {
        let task = self.task.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    /// Every row a crash left sending becomes uncertain.
    pub async fn launch(&self) -> Result<(), Error> {
        let now = self.parts.clock.now_ms();
        self.parts.store.write(move |tx, out| launch_in(tx, out, now).map(drop)).await
    }

    /// One pass: the unknown sends looked up, then what is due claimed and
    /// sent, one after another. A row whose write fails leaves the others to
    /// go on: it stays as it was for the next pass (a claimed one as
    /// uncertain after a crash), and the pass answers the first such error.
    pub async fn pass(&self) -> Result<(), Error> {
        let now = self.parts.clock.now_ms();
        let uncertain = self.parts.store.read(move |tx| tx.inbox_deliveries().due(UNCERTAIN, now, 20)).await?;
        let mut first = None;
        for row in uncertain {
            let id = row.id.clone();
            kept(&mut first, &id, self.reconcile(row).await);
        }
        self.resume_waiting().await?;
        let outcomes = self.parts.outcomes.clone();
        let claimed = self.write(move |tx, out, at| claim_in(tx, out, at, outcomes.as_ref())).await?;
        for row in claimed {
            let attempt = self.attempt(&row).await;
            let id = row.id.clone();
            let outcomes = self.parts.outcomes.clone();
            let recorded = self.write(move |tx, out, at| record_in(tx, out, at, outcomes.as_ref(), &id, attempt)).await;
            kept(&mut first, &row.id, recorded);
        }
        first.map_or(Ok(()), Err)
    }

    /// One write job with an [`Opening`] at the time it starts.
    async fn write<T: Send + 'static>(
        &self,
        job: impl FnOnce(&dyn eos_core::store::Tx, &mut eos_core::store::Outbox, &Opening<'_>) -> Result<T, Error>
        + Send
        + 'static,
    ) -> Result<T, Error> {
        let (now, ids, zone, control) =
            (self.parts.clock.now_ms(), self.parts.ids.clone(), self.parts.zone.clone(), self.parts.control.clone());
        self.parts
            .store
            .write(move |tx, out| {
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                job(tx, out, &at)
            })
            .await
    }

    async fn reconcile(&self, row: StoredDelivery) -> Result<(), Error> {
        let channel = self.parts.channels.get(&row.channel);
        let found = match (channel, target_of(&row.target)) {
            (Some(channel), Some(target)) => {
                let traits = channel.traits(&row.action);
                found(channel.lookup(&row.id, &target).await, traits)
            }
            _ => Found::Later,
        };
        let (id, outcomes) = (row.id.clone(), self.parts.outcomes.clone());
        self.write(move |tx, out, at| match found {
            Found::Sent(attempt) => record_in(tx, out, at, outcomes.as_ref(), &id, attempt),
            other => settle_in(tx, out, at, &id, other),
        })
        .await
    }

    /// Sends that waited for their capability go again once its channel is
    /// back (03 G23).
    async fn resume_waiting(&self) -> Result<(), Error> {
        let channels = self.parts.channels.clone();
        self.write(move |tx, out, at| resume_in(tx, out, at, channels.as_ref())).await
    }

    /// The channel's answer to one claimed row: its precondition, then the
    /// send.
    async fn attempt(&self, row: &StoredDelivery) -> Attempt {
        let Some(channel) = self.parts.channels.get(&row.channel) else { return Attempt::NoChannel };
        let Some(request) = request(row) else {
            let unreadable = SendError { kind: SendErrorKind::Permanent, detail_kind: "row".to_owned() };
            return Attempt::Failed(unreadable);
        };
        match channel.precondition(&request).await {
            Ok(Fresh::Fresh) => {}
            Ok(Fresh::Stale { reason }) => return Attempt::Stale(reason),
            Err(error) => return Attempt::Failed(error),
        }
        match channel.send(&request).await {
            Ok(receipt) => Attempt::Sent { receipt, traits: channel.traits(&row.action) },
            Err(error) => Attempt::Failed(error),
        }
    }

    /// How long until the next row that may go comes due, at most
    /// [`IDLE_MS`]; the longest while halt holds every send.
    async fn next_wait(&self) -> i64 {
        let now = self.parts.clock.now_ms();
        let next = self.parts.store.read(next_due_in).await;
        match next {
            Ok(Some(at)) => (at - now).clamp(0, IDLE_MS),
            Ok(None) => IDLE_MS,
            Err(_) => AFTER_ERROR_MS,
        }
    }
}

/// Keeps the first failed write of a pass, naming the row it was for.
fn kept(first: &mut Option<Error>, delivery_id: &str, written: Result<(), Error>) {
    if let Err(error) = written {
        tracing::warn!(delivery_id, %error, "a delivery's write failed; the others go on");
        first.get_or_insert(error);
    }
}
