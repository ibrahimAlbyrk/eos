//! Continuing a chat whose session is over, and waiting for it.
//!
//! A worker has one start at a time. Whatever needs the worker while its
//! session comes up (a message, a side question, a report) waits in the
//! worker's lane (`starts.rs`) instead of finding no session.

use eos_contracts::WorkerState;
use eos_core::Error;

use crate::service::Sessions;
use crate::starts::{Joined, Place};
use crate::transition::{Transition, transition_state};

/// How long anything waits for a session to come up before it gives up.
pub(crate) const START_WAIT_MS: i64 = 30_000;

impl Sessions {
    /// Continues the conversation of a worker whose session is over
    /// (`POST /workers/:id/resume`); refused when the worker is not at rest.
    /// Like any idle edge, the worker then takes the messages queued for it,
    /// oldest first.
    pub async fn resume(&self, worker_id: &str) -> Result<(), Error> {
        self.resumable(worker_id, true).await?;
        // Another start of it began meanwhile.
        let Some(place) = self.0.starts.open(worker_id) else {
            return Err(Error::Conflict("worker is not resumable (state SPAWNING)".into()));
        };
        self.run_start(place, worker_id, true).await
    }

    /// Starts the session of a chat at rest, in the background: opening the
    /// chat, a message to it. A live chat, or one already starting, is left
    /// as it is. Whoever needs the session waits for it
    /// ([`revive`](Self::revive), a message's dispatch) and hears how it went.
    pub async fn wake(&self, worker_id: &str) -> Result<(), Error> {
        if self.0.starts.is_open(worker_id) || self.resumable(worker_id, false).await?.is_none() {
            return Ok(());
        }
        let Some(place) = self.0.starts.open(worker_id) else { return Ok(()) };
        // Not tied to the caller: a request that goes away leaves no start half done.
        let (this, id) = (self.clone(), worker_id.to_owned());
        tokio::spawn(async move {
            if let Err(e) = this.run_start(place, &id, false).await {
                tracing::warn!(worker_id = %id, error = %e, "a chat's session could not be continued");
            }
        });
        Ok(())
    }

    /// Continues a chat at rest, or waits for the start of one coming up:
    /// afterwards the chat has its session, or the error says why not.
    pub async fn revive(&self, worker_id: &str) -> Result<(), Error> {
        self.wake(worker_id).await?;
        self.wait_for_start(worker_id).await.map(drop)
    }

    /// Waits, behind everyone who came before, for the worker's session when
    /// it is being started; the place returned holds back whoever comes
    /// after. `None` when no start is in flight.
    pub(crate) async fn wait_for_start(&self, worker_id: &str) -> Result<Option<Place>, Error> {
        match self.0.starts.join(worker_id) {
            Some(joined) => self.wait_joined(worker_id, joined).await.map(Some),
            None => Ok(None),
        }
    }

    /// [`wait_for_start`](Self::wait_for_start) for a lane already joined.
    pub(crate) async fn wait_joined(&self, worker_id: &str, joined: Joined) -> Result<Place, Error> {
        let gave_up = self.0.deps.sleeper.sleep(START_WAIT_MS);
        let entered = tokio::select! {
            entered = joined.enter() => entered,
            () = gave_up => {
                tracing::warn!(worker_id, "a chat's session did not come up in time");
                return Err(Error::Unreachable("worker".into()));
            }
        };
        match entered {
            (place, Some(Ok(()))) => Ok(place),
            (_, Some(Err(e))) => Err(e),
            // The start ended half way.
            (_, None) => Err(Error::Unreachable("worker".into())),
        }
    }

    /// A message for a chat whose session is coming up: from now on the chat
    /// is busy with it, as a message to a live chat is. `true` when this
    /// moved the row (it was at rest), so the caller hands it back with
    /// [`release_accepted`](Self::release_accepted).
    pub(crate) async fn accept_during_start(&self, worker_id: &str) -> Result<bool, Error> {
        let (id, now) = (worker_id.to_owned(), self.now());
        self.store()
            .write(move |tx, out| {
                let at_rest = tx
                    .workers()
                    .find(&id)?
                    .is_some_and(|w| matches!(w.state, WorkerState::Suspended | WorkerState::Done));
                Ok(at_rest
                    && transition_state(tx, out, now, &id, WorkerState::Spawning, "resume")? == Transition::Applied)
            })
            .await
    }

    /// The message accepted during a start went no further (it was queued,
    /// a repeat, a command, or the start failed): a row still starting goes
    /// idle when its session is up, else back to rest.
    pub(crate) async fn release_accepted(&self, worker_id: &str) {
        let (id, now, live) = (worker_id.to_owned(), self.now(), self.is_live(worker_id));
        let released = self
            .store()
            .write(move |tx, out| {
                if tx.workers().find(&id)?.is_none_or(|w| w.state != WorkerState::Spawning) {
                    return Ok(false);
                }
                let (next, reason) =
                    if live { (WorkerState::Idle, "resume_ready") } else { (WorkerState::Suspended, "resume_failed") };
                Ok(transition_state(tx, out, now, &id, next, reason)? == Transition::Applied && live)
            })
            .await;
        match released {
            Ok(true) => self.settled(worker_id).await,
            Ok(false) => {}
            Err(e) => tracing::warn!(worker_id, error = %e, "a chat's start could not be settled"),
        }
    }

    /// The start that holds the first place of the worker's lane.
    async fn run_start(&self, place: Place, worker_id: &str, strict: bool) -> Result<(), Error> {
        let started = self.start_resumed(worker_id, strict).await;
        place.finish(started.clone().map(drop));
        // What was queued before the session ended (a quit, a crash) goes out
        // now, with the start's place given back: a drain never waits for it.
        if started? {
            self.settled(worker_id).await;
        }
        Ok(())
    }
}
