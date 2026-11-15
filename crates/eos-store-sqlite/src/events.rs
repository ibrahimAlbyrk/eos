//! `events`.
//!
//! Retention: a worker keeps its whole log unless `events_max_per_worker` sets
//! a bound; then it keeps its newest that-many rows. The check runs every
//! [`PRUNE_CHECK_EVERY`] appends per worker, so a bounded log oscillates
//! between the bound and the bound plus that slack; start-up sweeps every
//! worker once (`prune_all`).

use eos_contracts::WorkerEventType;
use eos_core::Error;
use eos_core::store::{EventOrder, EventQuery, EventRepo};
use eos_domain::EventRecord;
use eos_kit_sqlite::rusqlite::{Row, params};

use crate::tx::{SqliteTx, failed};

pub(crate) const PRUNE_CHECK_EVERY: u32 = 1000;

fn record(row: &Row<'_>) -> Result<EventRecord, Error> {
    let read = || -> eos_kit_sqlite::rusqlite::Result<EventRecord> {
        Ok(EventRecord {
            id: row.get(0)?,
            worker_id: row.get(1)?,
            ts: row.get(2)?,
            kind: row.get(3)?,
            payload: row.get(4)?,
        })
    };
    read().map_err(failed)
}

/// The kind as stored: its wire name.
fn kind_name(kind: WorkerEventType) -> Result<String, Error> {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(name)) => Ok(name),
        _ => Err(Error::Storage(format!("event kind {kind:?} has no name"))),
    }
}

impl SqliteTx<'_> {
    /// Keeps the worker's newest `keep_newest` rows. The subquery finds the
    /// oldest row kept; with fewer rows it is NULL and nothing is deleted.
    fn prune_older_than_rank(&self, worker_id: &str, keep_newest: i64) -> Result<usize, Error> {
        if keep_newest <= 0 {
            return Ok(0);
        }
        let removed = self.exec(
            "DELETE FROM events WHERE worker_id = ?1 AND id < \
             (SELECT id FROM events WHERE worker_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
            params![worker_id, keep_newest - 1],
        )?;
        if removed > 0 {
            self.unindex_pruned(worker_id)?;
        }
        Ok(removed)
    }

    fn prune_if_due(&self, worker_id: &str) -> Result<(), Error> {
        let max = self.shared.events_max_per_worker;
        if max <= 0 {
            return Ok(());
        }
        let due = {
            let mut counts = self.shared.appends_since_prune.lock().unwrap_or_else(|p| p.into_inner());
            let count = counts.entry(worker_id.to_owned()).or_insert(0);
            *count += 1;
            let due = *count >= PRUNE_CHECK_EVERY;
            if due {
                *count = 0;
            }
            due
        };
        if due {
            self.prune_older_than_rank(worker_id, max)?;
        }
        Ok(())
    }
}

impl SqliteTx<'_> {
    /// A page of one worker's log with these columns, as [`EventRepo::list`] picks it.
    fn select<T>(
        &self,
        q: &EventQuery,
        columns: &str,
        map: impl Fn(&eos_kit_sqlite::rusqlite::Row<'_>) -> Result<T, Error>,
    ) -> Result<Vec<T>, Error> {
        // Ties on `ts` keep insertion order (`id`): clients close open tools on
        // the row that follows, so same-millisecond rows must not swap.
        if let Some(after) = q.after_id {
            let sql = format!("SELECT {columns} FROM events WHERE worker_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3");
            return self.rows(&sql, params![q.worker_id, after, q.limit], map);
        }
        // The newest rows, read newest first and handed back oldest first:
        // (ts, id) orders them wholly, so the reverse is (ts ASC, id ASC).
        let newest_first = |rows: Result<Vec<T>, Error>| {
            rows.map(|mut rows| {
                rows.reverse();
                rows
            })
        };
        match (q.order, q.before_id) {
            (EventOrder::Desc, Some(before)) => newest_first(self.rows(
                &format!(
                    "SELECT {columns} FROM events WHERE worker_id = ?1 AND ts > ?2 AND id < ?3 \
                     ORDER BY ts DESC, id DESC LIMIT ?4"
                ),
                params![q.worker_id, q.since, before, q.limit],
                map,
            )),
            (EventOrder::Desc, None) => newest_first(self.rows(
                &format!(
                    "SELECT {columns} FROM events WHERE worker_id = ?1 AND ts > ?2 ORDER BY ts DESC, id DESC LIMIT ?3"
                ),
                params![q.worker_id, q.since, q.limit],
                map,
            )),
            (EventOrder::Asc, _) => self.rows(
                &format!(
                    "SELECT {columns} FROM events WHERE worker_id = ?1 AND ts > ?2 ORDER BY ts ASC, id ASC LIMIT ?3"
                ),
                params![q.worker_id, q.since, q.limit],
                map,
            ),
        }
    }
}

impl EventRepo for SqliteTx<'_> {
    fn append(&self, worker_id: &str, ts: i64, kind: WorkerEventType, payload: Option<&str>) -> Result<i64, Error> {
        let kind = kind_name(kind)?;
        self.exec(
            "INSERT INTO events (worker_id, ts, type, payload) VALUES (?1, ?2, ?3, ?4)",
            params![worker_id, ts, kind, payload],
        )?;
        let id = self.conn.last_insert_rowid();
        self.index_appended(worker_id, id, ts, &kind, payload)?;
        self.prune_if_due(worker_id)?;
        Ok(id)
    }

    fn patch_payload(&self, row_id: i64, payload: &str) -> Result<(), Error> {
        self.exec("UPDATE events SET payload = ?1 WHERE id = ?2", params![payload, row_id])?;
        self.index_patched(row_id, payload)
    }

    fn list(&self, q: &EventQuery) -> Result<Vec<EventRecord>, Error> {
        self.select(q, "id, worker_id, ts, type, payload", record)
    }

    fn list_ids(&self, q: &EventQuery) -> Result<Vec<(i64, i64)>, Error> {
        self.select(q, "id, ts", |r| Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?)))
    }

    fn find_many(&self, worker_id: &str, ids: &[i64]) -> Result<Vec<EventRecord>, Error> {
        let ids = serde_json::to_string(ids).map_err(|e| Error::Storage(e.to_string()))?;
        // `+worker_id`: the ids are looked up by rowid; without statistics the
        // planner would walk the whole worker's index instead.
        self.rows(
            "SELECT id, worker_id, ts, type, payload FROM events \
             WHERE +worker_id = ?1 AND id IN (SELECT value FROM json_each(?2)) ORDER BY ts ASC, id ASC",
            params![worker_id, ids],
            record,
        )
    }

    fn scan(&self, worker_id: &str, kinds: &[&str], after_id: i64, limit: i64) -> Result<Vec<EventRecord>, Error> {
        let kinds = serde_json::to_string(kinds).map_err(|e| Error::Storage(e.to_string()))?;
        self.rows(
            "SELECT id, worker_id, ts, type, payload FROM events \
             WHERE worker_id = ?1 AND id > ?2 AND type IN (SELECT value FROM json_each(?3)) ORDER BY id ASC LIMIT ?4",
            params![worker_id, after_id, kinds, limit],
            record,
        )
    }

    fn list_by_type(
        &self,
        worker_id: &str,
        kind: WorkerEventType,
        limit: Option<i64>,
    ) -> Result<Vec<EventRecord>, Error> {
        // LIMIT -1 is SQLite's "no limit".
        self.rows(
            "SELECT id, worker_id, ts, type, payload FROM events WHERE worker_id = ?1 AND type = ?2 \
             ORDER BY id ASC LIMIT ?3",
            params![worker_id, kind_name(kind)?, limit.unwrap_or(-1)],
            record,
        )
    }

    fn last_id_by_type(&self, worker_id: &str, kind: WorkerEventType) -> Result<Option<i64>, Error> {
        self.row(
            "SELECT id FROM events WHERE worker_id = ?1 AND type = ?2 ORDER BY id DESC LIMIT 1",
            params![worker_id, kind_name(kind)?],
            |r| r.get(0).map_err(failed),
        )
    }

    fn list_by_type_containing(
        &self,
        worker_id: &str,
        kind: WorkerEventType,
        texts: &[&str],
    ) -> Result<Vec<EventRecord>, Error> {
        let texts = serde_json::to_string(texts).map_err(|e| Error::Storage(e.to_string()))?;
        self.rows(
            "SELECT id, worker_id, ts, type, payload FROM events WHERE worker_id = ?1 AND type = ?2 \
             AND payload IS NOT NULL \
             AND NOT EXISTS (SELECT 1 FROM json_each(?3) WHERE instr(events.payload, value) = 0) \
             ORDER BY id DESC",
            params![worker_id, kind_name(kind)?, texts],
            record,
        )
    }

    fn find(&self, worker_id: &str, row_id: i64) -> Result<Option<EventRecord>, Error> {
        self.row(
            "SELECT id, worker_id, ts, type, payload FROM events WHERE id = ?1 AND worker_id = ?2",
            params![row_id, worker_id],
            record,
        )
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM events WHERE worker_id = ?1", [worker_id])?;
        self.unindex_worker(worker_id)?;
        self.shared.appends_since_prune.lock().unwrap_or_else(|p| p.into_inner()).remove(worker_id);
        Ok(())
    }

    fn prune_all(&self, keep_newest: i64) -> Result<usize, Error> {
        if keep_newest <= 0 {
            return Ok(0);
        }
        let workers: Vec<String> =
            self.rows("SELECT DISTINCT worker_id FROM events", [], |r| r.get(0).map_err(failed))?;
        workers.iter().try_fold(0, |removed, id| Ok(removed + self.prune_older_than_rank(id, keep_newest)?))
    }
}
