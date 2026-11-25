//! `runs`, `run_events` and `run_results`.

use eos_core::Error;
use eos_core::routine::{FinishedRun, RoutineLoad};
use eos_core::store::{
    EndedCount, RUN_EVENTS_MAX, RUN_STATE_EVENT, RunCounts, RunMove, RunRepo, RunResultRepo, StoredRun, StoredRunEvent,
    StoredRunResult,
};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known, known_or_null};

const RUN_COLUMNS: &str = "id, routine_id, version_id, kind, origin, origin_ref, door, input, item_key, state, \
                           station, reason, attempt, resumed, not_before, priority, progress_done, progress_total, \
                           headline, outcome, cost_usd, work_ms, lead_id, device, remote, created_at, started_at, \
                           ended_at, updated_at";

/// A run that waits on the user: one waiting for the user, or one queued on
/// its open `run_start` item ("Run it?").
const WAITS_ON_USER: &str = "(state = 'waiting_for_user' OR (state = 'queued' AND EXISTS \
                             (SELECT 1 FROM inbox_items i WHERE i.run_id = runs.id AND i.kind = 'run_start' \
                             AND i.state IN ('open','later'))))";

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

    fn ended_since(&self, since: i64, limit: i64) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE ended_at >= ?1 ORDER BY ended_at DESC, rowid DESC LIMIT ?2"),
            params![since, limit],
            run,
        )
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

    fn page(
        &self,
        routine_id: Option<&str>,
        state: Option<RunState>,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!(
                "SELECT {RUN_COLUMNS} FROM runs WHERE (?1 IS NULL OR routine_id = ?1) AND (?2 IS NULL OR state = ?2) \
                 AND (?3 IS NULL OR created_at < ?3) ORDER BY created_at DESC, rowid DESC LIMIT ?4"
            ),
            params![routine_id, state.map(RunState::as_str), before, limit],
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

    fn move_to(&self, id: &str, change: &RunMove) -> Result<i64, Error> {
        let ended = change.state.is_terminal().then_some(change.at);
        let started = (change.state == RunState::Running).then_some(change.at);
        self.exec(
            "UPDATE runs SET state = ?1, station = ?2, reason = ?3, updated_at = ?4, \
             started_at = COALESCE(started_at, ?5), ended_at = COALESCE(?6, ended_at) WHERE id = ?7",
            params![
                change.state.as_str(),
                change.station.map(Station::as_str),
                change.reason.map(Reason::as_str),
                change.at,
                started,
                ended,
                id
            ],
        )?;
        let mut data = serde_json::Map::new();
        data.insert("state".into(), change.state.as_str().into());
        if let Some(station) = change.station {
            data.insert("station".into(), station.as_str().into());
        }
        if let Some(reason) = change.reason {
            data.insert("reason".into(), reason.as_str().into());
        }
        let data = serde_json::Value::Object(data).to_string();
        self.append_event(id, change.at, RUN_STATE_EVENT, Some(&data))?;
        Ok(self.conn.last_insert_rowid())
    }

    fn bind_version(&self, id: &str, version_id: &str) -> Result<(), Error> {
        self.exec("UPDATE runs SET version_id = ?1 WHERE id = ?2", params![version_id, id]).map(drop)
    }

    fn set_lead(&self, id: &str, worker_id: &str) -> Result<(), Error> {
        self.exec("UPDATE runs SET lead_id = ?1 WHERE id = ?2", params![worker_id, id]).map(drop)
    }

    fn set_outcome(&self, id: &str, outcome: Outcome) -> Result<(), Error> {
        self.exec("UPDATE runs SET outcome = ?1 WHERE id = ?2", params![outcome.as_str(), id]).map(drop)
    }

    fn set_attempt(&self, id: &str, attempt: i64) -> Result<(), Error> {
        self.exec("UPDATE runs SET attempt = ?1 WHERE id = ?2", params![attempt, id]).map(drop)
    }

    fn set_progress(&self, id: &str, done: i64, total: i64) -> Result<(), Error> {
        self.exec("UPDATE runs SET progress_done = ?1, progress_total = ?2 WHERE id = ?3", params![done, total, id])
            .map(drop)
    }

    fn set_headline(&self, id: &str, headline: &str) -> Result<(), Error> {
        self.exec("UPDATE runs SET headline = ?1 WHERE id = ?2", params![headline, id]).map(drop)
    }

    fn queued(&self) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE state = 'queued' ORDER BY priority, created_at, rowid"),
            [],
            run,
        )
    }

    fn at_work(&self) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE state IN ('running','checking') ORDER BY created_at, rowid"),
            [],
            run,
        )
    }

    fn paused_for(&self, reason: Reason) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!(
                "SELECT {RUN_COLUMNS} FROM runs WHERE state = 'paused' AND reason = ?1 ORDER BY created_at, rowid"
            ),
            [reason.as_str()],
            run,
        )
    }

    fn live_of(&self, routine_id: &str) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!(
                "SELECT {RUN_COLUMNS} FROM runs WHERE routine_id = ?1 \
                 AND state NOT IN ('done','failed','cancelled','skipped') ORDER BY created_at, rowid"
            ),
            [routine_id],
            run,
        )
    }

    fn set_resumed(&self, id: &str, resumed: i64) -> Result<(), Error> {
        self.exec("UPDATE runs SET resumed = ?1 WHERE id = ?2", params![resumed, id]).map(drop)
    }

    fn set_spent(&self, id: &str, cost_usd: f64, work_ms: i64) -> Result<(), Error> {
        self.exec("UPDATE runs SET cost_usd = ?1, work_ms = ?2 WHERE id = ?3", params![cost_usd, work_ms, id]).map(drop)
    }

    fn working(&self) -> Result<Vec<(String, i64)>, Error> {
        self.rows(
            "SELECT routine_id, COUNT(*) FROM runs WHERE state IN ('running','checking','delivering') \
             GROUP BY routine_id ORDER BY routine_id",
            [],
            |r| Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?)),
        )
    }

    fn by_item(&self, routine_id: &str, item_key: &str) -> Result<Vec<StoredRun>, Error> {
        self.rows(
            &format!(
                "SELECT {RUN_COLUMNS} FROM runs WHERE routine_id = ?1 AND item_key = ?2 \
                 ORDER BY created_at DESC, rowid DESC"
            ),
            params![routine_id, item_key],
            run,
        )
    }

    fn active(&self) -> Result<(i64, i64), Error> {
        let counts = self.row(
            &format!(
                "SELECT COUNT(CASE WHEN state IN ('running','checking','delivering') THEN 1 END), \
                 COUNT(CASE WHEN {WAITS_ON_USER} THEN 1 END) FROM runs \
                 WHERE state IN ('running','checking','delivering','waiting_for_user','queued')"
            ),
            [],
            |r| Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?)),
        )?;
        Ok(counts.unwrap_or_default())
    }

    fn waiting_on_user(&self) -> Result<Vec<String>, Error> {
        self.rows(&format!("SELECT id FROM runs WHERE {WAITS_ON_USER} ORDER BY id"), [], |r| r.get(0).map_err(failed))
    }

    fn cost_since(&self, routine_id: &str, since: i64) -> Result<f64, Error> {
        let cost = self.row(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE routine_id = ?1 AND created_at >= ?2",
            params![routine_id, since],
            |r| r.get::<_, f64>(0).map_err(failed),
        )?;
        Ok(cost.unwrap_or_default())
    }

    fn ended_counts(&self, since: i64) -> Result<Vec<EndedCount>, Error> {
        self.rows(
            "SELECT routine_id, COALESCE(outcome, state), COUNT(*) FROM runs WHERE ended_at >= ?1 \
             GROUP BY routine_id, COALESCE(outcome, state) ORDER BY routine_id, 2",
            [since],
            |r| {
                let read = || -> rusqlite::Result<EndedCount> {
                    Ok(EndedCount { routine_id: r.get(0)?, ended: r.get(1)?, count: r.get(2)? })
                };
                read().map_err(failed)
            },
        )
    }

    fn queued_count(&self) -> Result<i64, Error> {
        let count = self.row("SELECT COUNT(*) FROM runs WHERE state = 'queued'", [], |r| r.get(0).map_err(failed))?;
        Ok(count.unwrap_or_default())
    }

    fn load(&self, routine_id: &str, since: i64) -> Result<RoutineLoad, Error> {
        let load = self.row(
            "SELECT COUNT(CASE WHEN state = 'queued' THEN 1 END), COUNT(CASE WHEN created_at >= ?2 THEN 1 END), \
             COUNT(CASE WHEN state IN ('running','checking','waiting_for_user','delivering','paused') THEN 1 END) \
             FROM runs WHERE routine_id = ?1",
            params![routine_id, since],
            |r| {
                let read = || -> rusqlite::Result<RoutineLoad> {
                    Ok(RoutineLoad { queued: r.get(0)?, started_since: r.get(1)?, active: r.get(2)? })
                };
                read().map_err(failed)
            },
        )?;
        Ok(load.unwrap_or(RoutineLoad { queued: 0, started_since: 0, active: 0 }))
    }

    fn finished_after(&self, routine_id: &str, after_seq: i64, limit: i64) -> Result<Vec<FinishedRun>, Error> {
        // A run ends once, so its end is its last state change.
        self.rows(
            "SELECT e.id, runs.id, runs.state, runs.reason, runs.outcome, COALESCE(runs.ended_at, e.at) \
             FROM runs JOIN run_events e ON e.id = (SELECT MAX(id) FROM run_events \
             WHERE run_id = runs.id AND kind = ?4) \
             WHERE runs.routine_id = ?1 AND runs.state IN ('done','skipped','cancelled','failed') AND e.id > ?2 \
             ORDER BY e.id LIMIT ?3",
            params![routine_id, after_seq, limit, RUN_STATE_EVENT],
            |r| {
                let read = || -> rusqlite::Result<FinishedRun> {
                    Ok(FinishedRun {
                        seq: r.get(0)?,
                        run_id: r.get(1)?,
                        state: known(r, 2, RunState::parse)?,
                        reason: known_or_null(r, 3, Reason::parse)?,
                        outcome: known_or_null(r, 4, Outcome::parse)?,
                        ended_at: r.get(5)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }
}

impl RunResultRepo for SqliteTx<'_> {
    fn insert(&self, result: &StoredRunResult) -> Result<(), Error> {
        self.exec(
            &format!("INSERT OR REPLACE INTO run_results ({RESULT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
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

    fn set_verdict(&self, run_id: &str, attempt: i64, verdict: &str) -> Result<(), Error> {
        self.exec(
            "UPDATE run_results SET verdict = ?1 WHERE run_id = ?2 AND attempt = ?3",
            params![verdict, run_id, attempt],
        )
        .map(drop)
    }
}
