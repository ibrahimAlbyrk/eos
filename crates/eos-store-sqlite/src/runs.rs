//! `runs`, `run_events` and `run_results`.

use eos_core::Error;
use eos_core::store::{
    RUN_EVENTS_MAX, RUN_STATE_EVENT, RunCounts, RunRepo, RunResultRepo, StoredRun, StoredRunEvent, StoredRunResult,
};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known, known_or_null};

const RUN_COLUMNS: &str = "id, routine_id, version_id, kind, origin, origin_ref, door, input, item_key, state, \
                           station, reason, attempt, resumed, not_before, priority, progress_done, progress_total, \
                           headline, outcome, cost_usd, work_ms, lead_id, device, remote, created_at, started_at, \
                           ended_at, updated_at";

fn run(r: &rusqlite::Row<'_>) -> Result<StoredRun, Error> {
    let read = || -> rusqlite::Result<StoredRun> {
        Ok(StoredRun {
            id: r.get(0)?,
            routine_id: r.get(1)?,
            version_id: r.get(2)?,
            kind: r.get(3)?,
            origin: r.get(4)?,
            origin_ref: r.get(5)?,
            door: r.get(6)?,
            input: r.get(7)?,
            item_key: r.get(8)?,
            state: known(r, 9, RunState::parse)?,
            station: known_or_null(r, 10, Station::parse)?,
            reason: known_or_null(r, 11, Reason::parse)?,
            attempt: r.get(12)?,
            resumed: r.get(13)?,
            not_before: r.get(14)?,
            priority: r.get(15)?,
            progress_done: r.get(16)?,
            progress_total: r.get(17)?,
            headline: r.get(18)?,
            outcome: known_or_null(r, 19, Outcome::parse)?,
            cost_usd: r.get(20)?,
            work_ms: r.get(21)?,
            lead_id: r.get(22)?,
            device: r.get(23)?,
            remote: r.get(24)?,
            created_at: r.get(25)?,
            started_at: r.get(26)?,
            ended_at: r.get(27)?,
            updated_at: r.get(28)?,
        })
    };
    read().map_err(failed)
}

const RESULT_COLUMNS: &str = "run_id, attempt, kind, headline, body, files, verdict, created_at";

fn result(r: &rusqlite::Row<'_>) -> Result<StoredRunResult, Error> {
    let read = || -> rusqlite::Result<StoredRunResult> {
        Ok(StoredRunResult {
            run_id: r.get(0)?,
            attempt: r.get(1)?,
            kind: r.get(2)?,
            headline: r.get(3)?,
            body: r.get(4)?,
            files: r.get(5)?,
            verdict: r.get(6)?,
            created_at: r.get(7)?,
        })
    };
    read().map_err(failed)
}

impl RunRepo for SqliteTx<'_> {
    fn insert(&self, run: &StoredRun) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO runs ({RUN_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, \
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)"
            ),
            params![
                run.id,
                run.routine_id,
                run.version_id,
                run.kind,
                run.origin,
                run.origin_ref,
                run.door,
                run.input,
                run.item_key,
                run.state.as_str(),
                run.station.map(Station::as_str),
                run.reason.map(Reason::as_str),
                run.attempt,
                run.resumed,
                run.not_before,
                run.priority,
                run.progress_done,
                run.progress_total,
                run.headline,
                run.outcome.map(Outcome::as_str),
                run.cost_usd,
                run.work_ms,
                run.lead_id,
                run.device,
                run.remote,
                run.created_at,
                run.started_at,
                run.ended_at,
                run.updated_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredRun>, Error> {
        self.row(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"), [id], run)
    }

    fn by_routine(&self, routine_id: &str, limit: i64) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!(
                "SELECT {RUN_COLUMNS} FROM runs WHERE routine_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2"
            ),
            params![routine_id, limit],
            run,
        )
    }

    fn counts(&self, routine_id: &str, since: i64) -> Result<RunCounts, Error> {
        // The states that have not ended, as `idx_runs_live` lists them.
        let counts = self.row(
            "SELECT COUNT(CASE WHEN created_at >= ?2 THEN 1 END), \
             COUNT(CASE WHEN state IN ('queued','running','checking','waiting_for_user','delivering','paused') \
             THEN 1 END) FROM runs WHERE routine_id = ?1",
            params![routine_id, since],
            |r| {
                let read = || -> rusqlite::Result<RunCounts> { Ok(RunCounts { since: r.get(0)?, live: r.get(1)? }) };
                read().map_err(failed)
            },
        )?;
        Ok(counts.unwrap_or(RunCounts { since: 0, live: 0 }))
    }

    fn append_event(&self, run_id: &str, at: i64, kind: &str, data: Option<&str>) -> Result<(), Error> {
        self.exec(
            "INSERT INTO run_events (run_id, at, kind, data) VALUES (?1, ?2, ?3, ?4)",
            params![run_id, at, kind, data],
        )?;
        let held: Option<i64> =
            self.row("SELECT COUNT(*) FROM run_events WHERE run_id = ?1", [run_id], |r| r.get(0).map_err(failed))?;
        let over = held.unwrap_or_default() - RUN_EVENTS_MAX;
        if over > 0 {
            self.exec(
                "DELETE FROM run_events WHERE id IN \
                 (SELECT id FROM run_events WHERE run_id = ?1 AND kind != ?2 ORDER BY id LIMIT ?3)",
                params![run_id, RUN_STATE_EVENT, over],
            )?;
        }
        Ok(())
    }

    fn events(&self, run_id: &str) -> Result<Vec<StoredRunEvent>, Error> {
        self.rows("SELECT id, run_id, at, kind, data FROM run_events WHERE run_id = ?1 ORDER BY id", [run_id], |r| {
            let read = || -> rusqlite::Result<StoredRunEvent> {
                Ok(StoredRunEvent { id: r.get(0)?, run_id: r.get(1)?, at: r.get(2)?, kind: r.get(3)?, data: r.get(4)? })
            };
            read().map_err(failed)
        })
    }
}

impl RunResultRepo for SqliteTx<'_> {
    fn insert(&self, result: &StoredRunResult) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO run_results ({RESULT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
            params![
                result.run_id,
                result.attempt,
                result.kind,
                result.headline,
                result.body,
                result.files,
                result.verdict,
                result.created_at,
            ],
        )
        .map(drop)
    }

    fn by_run(&self, run_id: &str) -> Result<Vec<StoredRunResult>, Error> {
        self.rows(
            &format!("SELECT {RESULT_COLUMNS} FROM run_results WHERE run_id = ?1 ORDER BY attempt"),
            [run_id],
            result,
        )
    }
}
