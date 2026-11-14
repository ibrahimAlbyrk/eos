//! Sessions coming back.
//!
//! A chat at rest is continued in the background. Whoever needs it meanwhile
//! (a message, a side question, a report) waits for that start instead of
//! finding no session, and hears how it went. They go on in the order they
//! came: each holds its place in the worker's lane until its message is
//! delivered, and the lane stays open until the last of them is through, so
//! nothing that arrives later overtakes them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::Error;
use tokio::sync::OwnedMutexGuard;

/// How the start went; `None` while it runs, or when it was dropped half way.
type Outcome = Option<Result<(), Error>>;

type Lane = tokio::sync::Mutex<Outcome>;

struct Entry {
    /// Fair: places are taken in the order they were asked for.
    lane: Arc<Lane>,
    /// The places handed out and not yet given back, the start's own among them.
    users: usize,
}

/// The lanes of the workers whose session is being started. Cheap to clone.
#[derive(Default, Clone)]
pub(crate) struct Starts(Arc<Mutex<HashMap<String, Entry>>>);

/// A place in a worker's lane. While it is held, nobody behind it goes on.
pub(crate) struct Place {
    // Declared first: dropped before the ticket gives the place back.
    guard: Option<OwnedMutexGuard<Outcome>>,
    _ticket: Ticket,
}

/// A user of a lane; the lane closes with its last one.
struct Ticket {
    starts: Starts,
    worker_id: String,
    lane: Arc<Lane>,
}

impl Starts {
    fn lanes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens the worker's lane for a start, the start first in it; `None`
    /// when the worker has a lane already.
    pub(crate) fn open(&self, worker_id: &str) -> Option<Place> {
        let mut lanes = self.lanes();
        if lanes.contains_key(worker_id) {
            return None;
        }
        let lane = Arc::new(Lane::new(None));
        // A lane nobody else has seen yet is free.
        let guard = lane.clone().try_lock_owned().ok()?;
        lanes.insert(worker_id.to_owned(), Entry { lane: lane.clone(), users: 1 });
        let ticket = Ticket { starts: self.clone(), worker_id: worker_id.to_owned(), lane };
        Some(Place { guard: Some(guard), _ticket: ticket })
    }

    /// Whether a start of the worker is running or still has people waiting on it.
    pub(crate) fn is_open(&self, worker_id: &str) -> bool {
        self.lanes().contains_key(worker_id)
    }

    /// Waits behind everyone already in the worker's lane, then answers how
    /// its start went. `None` at once when the worker has no lane.
    pub(crate) async fn enter(&self, worker_id: &str) -> Option<(Place, Outcome)> {
        let ticket = {
            let mut lanes = self.lanes();
            let entry = lanes.get_mut(worker_id)?;
            entry.users += 1;
            Ticket { starts: self.clone(), worker_id: worker_id.to_owned(), lane: entry.lane.clone() }
        };
        let guard = ticket.lane.clone().lock_owned().await;
        let outcome = guard.clone();
        Some((Place { guard: Some(guard), _ticket: ticket }, outcome))
    }

    /// How many workers have a lane open.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.lanes().len()
    }
}

impl Place {
    /// The start this place opened is over: the next in line hears how it went.
    pub(crate) fn finish(mut self, outcome: Result<(), Error>) {
        if let Some(guard) = self.guard.as_mut() {
            **guard = Some(outcome);
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut lanes = self.starts.lanes();
        let Some(entry) = lanes.get_mut(&self.worker_id) else { return };
        if !Arc::ptr_eq(&entry.lane, &self.lane) {
            return;
        }
        entry.users -= 1;
        if entry.users == 0 {
            lanes.remove(&self.worker_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn the_start_goes_first_then_everyone_in_the_order_they_came() {
        let starts = Starts::default();
        let start = starts.open("w-1").expect("no lane yet");
        assert!(starts.open("w-1").is_none(), "one start at a time");
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiting = Vec::new();
        for n in 0..3 {
            let (starts, order) = (starts.clone(), order.clone());
            waiting.push(tokio::spawn(async move {
                let (place, outcome) = starts.enter("w-1").await.expect("a lane");
                order.lock().expect("order").push(n);
                tokio::time::sleep(Duration::from_millis(5)).await;
                drop(place);
                outcome
            }));
            // Each is in line before the next one asks.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(order.lock().expect("order").is_empty(), "nobody passes the start");
        start.finish(Err(Error::Rule("no credential".into())));
        for waiter in waiting {
            assert_eq!(waiter.await.expect("joins"), Some(Err(Error::Rule("no credential".into()))));
        }
        assert_eq!(*order.lock().expect("order"), [0, 1, 2]);
        assert_eq!(starts.len(), 0, "the lane closes with its last user");
        assert!(starts.enter("w-1").await.is_none());
    }

    #[tokio::test]
    async fn a_waiter_that_gives_up_leaves_no_lane_behind() {
        let starts = Starts::default();
        let start = starts.open("w-1").expect("no lane yet");
        let gave_up = tokio::time::timeout(Duration::from_millis(5), starts.enter("w-1")).await;
        assert!(gave_up.is_err());
        start.finish(Ok(()));
        assert_eq!(starts.len(), 0);
        assert!(!starts.is_open("w-1"));

        // A start dropped half way tells those waiting that it never finished.
        let start = starts.open("w-1").expect("open again");
        let waiter = tokio::spawn({
            let starts = starts.clone();
            async move { starts.enter("w-1").await.map(|(_, outcome)| outcome) }
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        drop(start);
        assert_eq!(waiter.await.expect("joins"), Some(None));
        assert_eq!(starts.len(), 0);
    }
}
