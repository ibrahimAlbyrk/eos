//! `worker_loops` (`infra/src/persistence/SqliteLoopStateRepo.ts`).

use eos_contracts::{LoopStatus, LoopStrategy};
use eos_core::Error;
use eos_core::store::{LoopRepo, NewLoop};
use eos_domain::WorkerLoop;
use eos_kit_sqlite::rusqlite::{Row, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str = "id, worker_id, parent_id, goal_json, strategy, status, attempt, max_attempts, held_report, \
    last_reason, awaiting_input, check_failures, started_at, updated_at";

/// A stored enum name (`active`, `hybrid`) as its type.
fn named<T: serde::de::DeserializeOwned>(what: &str, name: String) -> Result<T, Error> {
    serde_json::from_value(serde_json::Value::String(name.clone()))
        .map_err(|_| Error::Storage(format!("a loop has an unknown {what}: {name}")))
}

fn worker_loop(row: &Row<'_>) -> Result<WorkerLoop, Error> {
    // The three columns that need decoding, then the rest as stored.
    let read = || -> eos_kit_sqlite::rusqlite::Result<(String, String, String, WorkerLoop)> {
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
        };
        Ok((row.get(3)?, row.get(4)?, row.get(5)?, partial))
    };
    let (goal, strategy, status, partial) = read().map_err(failed)?;
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

    fn delete(&self, id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_loops WHERE id = ?1", [id]).map(drop)
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_loops WHERE worker_id = ?1", [worker_id]).map(drop)
    }
}
