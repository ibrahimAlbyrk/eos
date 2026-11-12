//! `worker_loops` (`infra/src/persistence/SqliteLoopStateRepo.ts`).

use eos_contracts::{LoopStatus, LoopStrategy};
use eos_core::Error;
use eos_core::store::{LoopAmend, LoopRepo, NewLoop};
use eos_domain::WorkerLoop;
use eos_domain::loops::LoopAttempt;
use eos_domain::loops::progress::with_attempt;
use eos_kit_sqlite::rusqlite::{Row, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str = "id, worker_id, parent_id, goal_json, strategy, status, attempt, max_attempts, held_report, \
    last_reason, awaiting_input, check_failures, started_at, updated_at, progress_ring";

/// A stored enum name (`active`, `hybrid`) as its type.
fn named<T: serde::de::DeserializeOwned>(what: &str, name: String) -> Result<T, Error> {
    serde_json::from_value(serde_json::Value::String(name.clone()))
        .map_err(|_| Error::Storage(format!("a loop has an unknown {what}: {name}")))
}

fn worker_loop(row: &Row<'_>) -> Result<WorkerLoop, Error> {
    // The three columns that need decoding, then the rest as stored.
    let read = || -> eos_kit_sqlite::rusqlite::Result<(String, String, String, Option<String>, WorkerLoop)> {
        let partial = WorkerLoop {
            id: row.get(0)?,
            worker_id: row.get(1)?,
            parent_id: row.get(2)?,
            goal: serde_json::Value::Null,
            strategy: LoopStrategy::Hybrid,
            status: LoopStatus::Active,
            attempt: row.get(6)?,
            max_attempts: row.get(7)?,
            held_report: row.get(8)?,
            last_reason: row.get(9)?,
            awaiting_input: row.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
            check_failures: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
            started_at: row.get(12)?,
            updated_at: row.get(13)?,
            progress_ring: Vec::new(),
        };
        Ok((row.get(3)?, row.get(4)?, row.get(5)?, row.get::<_, Option<String>>(14)?, partial))
    };
    let (goal, strategy, status, ring, partial) = read().map_err(failed)?;
    // A ring that does not read is a fresh window, as today's code reads it.
    let progress_ring = ring.and_then(|text| serde_json::from_str::<Vec<LoopAttempt>>(&text).ok()).unwrap_or_default();
    let partial = WorkerLoop { progress_ring, ..partial };
    let goal = serde_json::from_str(&goal)
        .map_err(|e| Error::Storage(format!("loop {} has an unreadable goal: {e}", partial.id)))?;
    Ok(WorkerLoop { goal, strategy: named("strategy", strategy)?, status: named("status", status)?, ..partial })
}

fn name_of<T: serde::Serialize>(value: T) -> Result<String, Error> {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => Ok(name),
        _ => Err(Error::Storage("a loop field has no stored name".into())),
    }
}

impl LoopRepo for SqliteTx<'_> {
    fn insert(&self, new: &NewLoop) -> Result<(), Error> {
        let goal = serde_json::to_string(&new.goal).map_err(Error::storage)?;
        self.exec(
            "INSERT INTO worker_loops (id, worker_id, parent_id, goal_json, strategy, status, attempt, max_attempts, \
             started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 0, ?6, ?7, ?7)",
            params![
                new.id,
                new.worker_id,
                new.parent_id,
                goal,
                name_of(new.strategy)?,
                new.max_attempts,
                new.started_at
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<WorkerLoop>, Error> {
        self.row(&format!("SELECT {COLUMNS} FROM worker_loops WHERE id = ?1"), [id], worker_loop)
    }

    fn find_active_by_worker(&self, worker_id: &str) -> Result<Option<WorkerLoop>, Error> {
        let sql = format!("SELECT {COLUMNS} FROM worker_loops WHERE worker_id = ?1 AND status = 'active' LIMIT 1");
        self.row(&sql, [worker_id], worker_loop)
    }

    fn find_any_by_worker(&self, worker_id: &str) -> Result<Option<WorkerLoop>, Error> {
        let sql = format!("SELECT {COLUMNS} FROM worker_loops WHERE worker_id = ?1 ORDER BY started_at DESC LIMIT 1");
        self.row(&sql, [worker_id], worker_loop)
    }

    fn list_active(&self) -> Result<Vec<WorkerLoop>, Error> {
        let sql = format!("SELECT {COLUMNS} FROM worker_loops WHERE status = 'active' ORDER BY started_at ASC");
        self.rows(&sql, [], worker_loop)
    }

    fn set_status(&self, id: &str, status: LoopStatus, now: i64) -> Result<(), Error> {
        self.exec(
            "UPDATE worker_loops SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![name_of(status)?, now, id],
        )
        .map(drop)
    }

    fn set_awaiting_input(&self, id: &str, awaiting: bool, now: i64) -> Result<(), Error> {
        self.exec(
            "UPDATE worker_loops SET awaiting_input = ?1, updated_at = ?2 WHERE id = ?3",
            params![awaiting, now, id],
        )
        .map(drop)
    }

    fn set_held_report(&self, id: &str, report: Option<&str>, now: i64) -> Result<(), Error> {
        self.exec("UPDATE worker_loops SET held_report = ?1, updated_at = ?2 WHERE id = ?3", params![report, now, id])
            .map(drop)
    }

    fn set_check_failures(&self, id: &str, failures: i64, now: i64) -> Result<(), Error> {
        self.exec(
            "UPDATE worker_loops SET check_failures = ?1, updated_at = ?2 WHERE id = ?3",
            params![failures, now, id],
        )
        .map(drop)
    }

    fn amend(&self, id: &str, patch: &LoopAmend, now: i64) -> Result<(), Error> {
        let Some(current) = self.find(id)? else { return Ok(()) };
        let goal = match &patch.goal {
            Some(goal) => serde_json::to_string(goal).map_err(Error::storage)?,
            None => serde_json::to_string(&current.goal).map_err(Error::storage)?,
        };
        let strategy = name_of(patch.strategy.unwrap_or(current.strategy))?;
        let max_attempts = patch.max_attempts.unwrap_or(current.max_attempts);
        self.exec(
            "UPDATE worker_loops SET goal_json = ?1, strategy = ?2, max_attempts = ?3, updated_at = ?4 WHERE id = ?5",
            params![goal, strategy, max_attempts, now, id],
        )
        .map(drop)
    }

    fn reset_progress(&self, id: &str, now: i64) -> Result<(), Error> {
        self.exec("UPDATE worker_loops SET progress_ring = NULL, updated_at = ?1 WHERE id = ?2", params![now, id])
            .map(drop)
    }

    fn record_attempt(&self, id: &str, attempt: &LoopAttempt, now: i64) -> Result<(), Error> {
        let Some(current) = self.find(id)? else { return Ok(()) };
        let ring =
            serde_json::to_string(&with_attempt(&current.progress_ring, attempt.clone())).map_err(Error::storage)?;
        self.exec(
            "UPDATE worker_loops SET attempt = attempt + 1, progress_ring = ?1, last_reason = ?2, updated_at = ?3 \
             WHERE id = ?4",
            params![ring, attempt.reason, now, id],
        )
        .map(drop)
    }

    fn delete(&self, id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_loops WHERE id = ?1", [id]).map(drop)
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_loops WHERE worker_id = ?1", [worker_id]).map(drop)
    }
}
