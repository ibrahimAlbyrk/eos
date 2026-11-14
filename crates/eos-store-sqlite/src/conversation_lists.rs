//! `conversation_list_facts` and `conversation_list_marks`: each row's facts
//! for the conversation-wide lists, and how far each worker's log was read in.
//!
//! A worker is read in the first time its lists are asked for; from then on
//! every append of its log adds its row in the same transaction. A row
//! appended by a build that does not keep the table leaves a gap below the
//! next append, which is then left for [`catch_up`](ConversationListRepo::catch_up).

use eos_core::Error;
use eos_core::store::ConversationListRepo;
use eos_domain::transcript::{IndexedRow, RowFacts, SUBAGENT_ROW_KINDS};
use eos_kit_sqlite::rusqlite::{OptionalExtension, params};

use crate::tx::{SqliteTx, failed};

impl SqliteTx<'_> {
    fn mark(&self, worker_id: &str) -> Result<Option<i64>, Error> {
        self.conn
            .prepare_cached("SELECT through_id FROM conversation_list_marks WHERE worker_id = ?1")
            .and_then(|mut stmt| stmt.query_row([worker_id], |r| r.get(0)).optional())
            .map_err(failed)
    }

    fn set_mark(&self, worker_id: &str, through_id: i64) -> Result<(), Error> {
        self.exec(
            "INSERT INTO conversation_list_marks (worker_id, through_id) VALUES (?1, ?2) \
             ON CONFLICT(worker_id) DO UPDATE SET through_id = excluded.through_id",
            params![worker_id, through_id],
        )
        .map(drop)
    }

    /// Counts a change of the worker's facts.
    fn bump(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("UPDATE conversation_list_marks SET version = version + 1 WHERE worker_id = ?1", [worker_id])
            .map(drop)
    }

    /// Stores (or drops) the facts of one row; `true` when that changed any.
    fn put_facts(&self, worker_id: &str, id: i64, ts: i64, kind: &str, payload: Option<&str>) -> Result<bool, Error> {
        let facts = SUBAGENT_ROW_KINDS.contains(&kind).then(|| RowFacts::of(kind, payload)).flatten();
        match facts {
            Some(facts) => self.exec(
                "INSERT OR REPLACE INTO conversation_list_facts (event_id, worker_id, ts, facts) VALUES (?1, ?2, ?3, ?4)",
                params![id, worker_id, ts, facts.to_json()],
            ),
            None => self.exec("DELETE FROM conversation_list_facts WHERE event_id = ?1", [id]),
        }
        .map(|changed| changed > 0)
    }

    /// The append path: a row of a worker read in is added at once, unless an
    /// older build appended rows since (they are read in on demand).
    pub(crate) fn index_appended(
        &self,
        worker_id: &str,
        id: i64,
        ts: i64,
        kind: &str,
        payload: Option<&str>,
    ) -> Result<(), Error> {
        let Some(through) = self.mark(worker_id)? else { return Ok(()) };
        let gap: bool = self
            .row(
                "SELECT EXISTS (SELECT 1 FROM events WHERE worker_id = ?1 AND id > ?2 AND id < ?3)",
                params![worker_id, through, id],
                |r| r.get(0).map_err(failed),
            )?
            .unwrap_or(false);
        if gap {
            return Ok(());
        }
        self.set_mark(worker_id, id)?;
        if self.put_facts(worker_id, id, ts, kind, payload)? {
            self.bump(worker_id)?;
        }
        Ok(())
    }

    /// A row whose payload changed keeps facts that match it.
    pub(crate) fn index_patched(&self, row_id: i64, payload: &str) -> Result<(), Error> {
        let indexed = self.row(
            "SELECT e.worker_id, e.ts, e.type FROM conversation_list_facts f JOIN events e ON e.id = f.event_id \
             WHERE f.event_id = ?1",
            [row_id],
            |r| {
                Ok((
                    r.get::<_, String>(0).map_err(failed)?,
                    r.get(1).map_err(failed)?,
                    r.get::<_, String>(2).map_err(failed)?,
                ))
            },
        )?;
        match indexed {
            Some((worker_id, ts, kind)) => {
                if self.put_facts(&worker_id, row_id, ts, &kind, Some(payload))? {
                    self.bump(&worker_id)?;
                }
                Ok(())
            }
            None => Ok(()),
        }
    }

    pub(crate) fn unindex_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM conversation_list_facts WHERE worker_id = ?1", [worker_id])?;
        self.exec("DELETE FROM conversation_list_marks WHERE worker_id = ?1", [worker_id]).map(drop)
    }

    /// Drops the facts of the worker's rows that are gone (pruning removes the oldest).
    pub(crate) fn unindex_pruned(&self, worker_id: &str) -> Result<(), Error> {
        let removed = self.exec(
            "DELETE FROM conversation_list_facts WHERE worker_id = ?1 \
             AND event_id < COALESCE((SELECT min(id) FROM events WHERE worker_id = ?1), 9223372036854775807)",
            [worker_id],
        )?;
        if removed > 0 {
            self.bump(worker_id)?;
        }
        Ok(())
    }

    /// The worker's newest and oldest row ids.
    fn log_bounds(&self, worker_id: &str) -> Result<(Option<i64>, Option<i64>), Error> {
        self.row(
            "SELECT (SELECT max(id) FROM events WHERE worker_id = ?1), (SELECT min(id) FROM events WHERE worker_id = ?1)",
            [worker_id],
            |r| Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?)),
        )
        .map(Option::unwrap_or_default)
    }
}

impl ConversationListRepo for SqliteTx<'_> {
    fn version(&self, worker_id: &str) -> Result<Option<i64>, Error> {
        self.conn
            .prepare_cached("SELECT version FROM conversation_list_marks WHERE worker_id = ?1")
            .and_then(|mut stmt| stmt.query_row([worker_id], |r| r.get(0)).optional())
            .map_err(failed)
    }

    fn is_current(&self, worker_id: &str) -> Result<bool, Error> {
        let (newest, oldest) = self.log_bounds(worker_id)?;
        let Some(through) = self.mark(worker_id)? else { return Ok(newest.is_none()) };
        let oldest_fact: Option<i64> = self
            .row("SELECT min(event_id) FROM conversation_list_facts WHERE worker_id = ?1", [worker_id], |r| {
                r.get(0).map_err(failed)
            })?
            .flatten();
        let gone_kept = match (oldest_fact, oldest) {
            (Some(fact), Some(oldest)) => fact < oldest,
            (Some(_), None) => true,
            (None, _) => false,
        };
        Ok(newest.is_none_or(|newest| through >= newest) && !gone_kept)
    }

    fn catch_up(&self, worker_id: &str, limit: i64) -> Result<bool, Error> {
        let (newest, _) = self.log_bounds(worker_id)?;
        self.unindex_pruned(worker_id)?;
        let Some(newest) = newest else {
            self.unindex_worker(worker_id)?;
            return Ok(true);
        };
        let through = self.mark(worker_id)?.unwrap_or(0);
        let rows = eos_core::store::EventRepo::scan(self, worker_id, &SUBAGENT_ROW_KINDS, through, limit)?;
        let mut changed = false;
        for row in &rows {
            changed |= self.put_facts(worker_id, row.id, row.ts, &row.kind, row.payload.as_deref())?;
        }
        let done = (rows.len() as i64) < limit;
        // A short slice saw every row up to the newest (the rest are kinds no list reads).
        let read_to = if done { newest } else { rows.last().map_or(newest, |r| r.id) };
        self.set_mark(worker_id, read_to.max(through))?;
        if changed {
            self.bump(worker_id)?;
        }
        Ok(done)
    }

    fn facts(&self, worker_id: &str) -> Result<Vec<IndexedRow>, Error> {
        let rows = self.rows(
            "SELECT event_id, ts, facts FROM conversation_list_facts WHERE worker_id = ?1 ORDER BY event_id",
            [worker_id],
            |r| {
                let facts: String = r.get(2).map_err(failed)?;
                Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?, facts))
            },
        )?;
        // Facts this build cannot read were written by another one: read as none.
        Ok(rows
            .into_iter()
            .filter_map(|(id, ts, facts): (i64, i64, String)| {
                RowFacts::from_json(&facts).map(|facts| IndexedRow { id, ts, facts })
            })
            .collect())
    }
}
