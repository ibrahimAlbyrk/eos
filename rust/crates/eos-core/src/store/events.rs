//! The `events` table: each worker's append-only log (`core/src/ports/EventRepo.ts`).

use eos_contracts::WorkerEventType;
use eos_domain::EventRecord;
use serde::Serialize;

use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EventOrder {
    /// The oldest rows after `since`, oldest first.
    Asc,
    /// The newest rows, still returned oldest first (reading order).
    #[default]
    Desc,
}

/// One page of a worker's log. Rows always come back oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventQuery {
    pub worker_id: String,
    /// Only rows later than this time (epoch ms).
    pub since: i64,
    pub limit: i64,
    pub order: EventOrder,
    /// Only rows older than this id ("load older"). With `Desc` only.
    pub before_id: Option<i64>,
    /// Only rows newer than this id, in insertion order. Wins over
    /// `order`, `since` and `before_id`.
    pub after_id: Option<i64>,
}

pub trait EventRepo {
    /// Appends a row and returns its id. `payload` is JSON text.
    fn append(&self, worker_id: &str, ts: i64, kind: WorkerEventType, payload: Option<&str>) -> Result<i64, Error>;
    /// Replaces a row's payload (JSON text).
    fn patch_payload(&self, row_id: i64, payload: &str) -> Result<(), Error>;
    fn list(&self, query: &EventQuery) -> Result<Vec<EventRecord>, Error>;
    /// Every row of one kind, in insertion order; `limit` caps it.
    fn list_by_type(
        &self,
        worker_id: &str,
        kind: WorkerEventType,
        limit: Option<i64>,
    ) -> Result<Vec<EventRecord>, Error>;
    /// One row by id; `None` when it is gone or belongs to another worker.
    fn find(&self, worker_id: &str, row_id: i64) -> Result<Option<EventRecord>, Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
    /// Keeps each worker's newest `keep_newest` rows; returns how many went.
    fn prune_all(&self, keep_newest: i64) -> Result<usize, Error>;
}

impl dyn EventRepo + '_ {
    /// [`append`](EventRepo::append) with the payload serialized here.
    pub fn append_json<T: Serialize + ?Sized>(
        &self,
        worker_id: &str,
        ts: i64,
        kind: WorkerEventType,
        payload: &T,
    ) -> Result<i64, Error> {
        let json = serde_json::to_string(payload).map_err(Error::storage)?;
        self.append(worker_id, ts, kind, Some(&json))
    }
}
