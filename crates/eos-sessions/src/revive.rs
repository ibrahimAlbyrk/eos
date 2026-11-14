//! Continuing a chat whose session is over, and waiting for it.
//!
//! A worker has one start at a time. Whatever needs the worker while its
//! session comes up (a message, a side question, a report) waits in the
//! worker's lane (`starts.rs`) instead of finding no session.

use eos_core::Error;

use crate::service::Sessions;
use crate::starts::Place;

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
        if !self.0.starts.is_open(worker_id) {
            return Ok(None);
        }
        let gave_up = self.0.deps.sleeper.sleep(START_WAIT_MS);
        let entered = tokio::select! {
            entered = self.0.starts.enter(worker_id) => entered,
            () = gave_up => {
                tracing::warn!(worker_id, "a chat's session did not come up in time");
                return Err(Error::Unreachable("worker".into()));
            }
        };
        match entered {
            None => Ok(None),
            Some((place, Some(Ok(())))) => Ok(Some(place)),
            Some((_, Some(Err(e)))) => Err(e),
            // The start ended half way.
            Some((_, None)) => Err(Error::Unreachable("worker".into())),
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
