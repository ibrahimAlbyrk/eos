//! Clearing old routine history: runs past what their routine keeps, with
//! every row that hangs on them, and routines that leave for good.

use eos_core::Error;
use eos_core::store::{EndedRun, Leaving, LeavingRoutine, RoutineRetentionRepo};
use eos_domain::routine::numbers::WEEK_MS;
use eos_kit_sqlite::rusqlite::params;

use crate::tx::{SqliteTx, failed, wire_word};

const ENDED: &str = "('done', 'skipped', 'cancelled', 'failed')";

impl SqliteTx<'_> {
    /// Deletes one run and what hangs on it. With `keep_first_week`, its
    /// outcomes inside its routine's first week from its start stay.
    fn drop_run(&self, id: &str, keep_first_week: bool) -> Result<usize, Error> {
        for table in ["run_events", "run_results", "routine_sessions", "inbox_deliveries", "inbox_edits"] {
            self.exec(&format!("DELETE FROM {table} WHERE run_id = ?1"), [id])?;
        }
        if keep_first_week {
            self.exec(
                "DELETE FROM inbox_outcomes WHERE run_id = ?1 AND NOT EXISTS (SELECT 1 FROM routines r \
                 WHERE r.id = inbox_outcomes.routine_id AND inbox_outcomes.at >= r.started_at \
                 AND inbox_outcomes.at < r.started_at + ?2)",
                params![id, WEEK_MS],
            )?;
        } else {
            self.exec("DELETE FROM inbox_outcomes WHERE run_id = ?1", [id])?;
        }
        self.exec("DELETE FROM runs WHERE id = ?1", [id])
    }
}

impl RoutineRetentionRepo for SqliteTx<'_> {
    fn runs_past(
        &self,
        keep: i64,
        ended_by: i64,
        after: Option<(i64, &str)>,
        limit: i64,
    ) -> Result<Vec<EndedRun>, Error> {
        let (after_end, after_id) = after.unwrap_or((i64::MIN, ""));
        self.rows(
            &format!(
                "SELECT id, routine_id, ended_at FROM (SELECT id, routine_id, state, ended_at, ROW_NUMBER() OVER \
                 (PARTITION BY routine_id ORDER BY created_at DESC, id DESC) AS place FROM runs) \
                 WHERE place > ?1 AND ended_at <= ?2 AND state IN {ENDED} AND (ended_at, id) > (?3, ?4) \
                 ORDER BY ended_at, id LIMIT ?5"
            ),
            params![keep, ended_by, after_end, after_id, limit],
            |r| {
                Ok(EndedRun {
                    id: r.get(0).map_err(failed)?,
                    routine_id: r.get(1).map_err(failed)?,
                    ended_at: r.get(2).map_err(failed)?,
                })
            },
        )
    }

    fn delete_runs(&self, ids: &[String]) -> Result<usize, Error> {
        let mut deleted = 0;
        for id in ids {
            deleted += self.drop_run(id, true)?;
        }
        Ok(deleted)
    }

    fn transcripts_past(&self, ended_by: i64, after: &str, limit: i64) -> Result<Vec<String>, Error> {
        self.rows(
            &format!(
                "SELECT s.worker_id FROM routine_sessions s JOIN runs ON runs.id = s.run_id \
                 JOIN workers w ON w.id = s.worker_id \
                 WHERE runs.ended_at <= ?1 AND runs.state IN {ENDED} AND s.worker_id > ?2 \
                 ORDER BY s.worker_id LIMIT ?3"
            ),
            params![ended_by, after, limit],
            |r| r.get(0).map_err(failed),
        )
    }

    fn leaving(&self, when: &Leaving, after: &str, limit: i64) -> Result<Vec<LeavingRoutine>, Error> {
        self.rows(
            "SELECT id, name, state FROM routines r WHERE r.id > ?4 \
             AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.routine_id = r.id AND runs.ended_at IS NULL) \
             AND ((r.state = 'deleted' AND r.deleted_at <= ?1) \
               OR (r.state = 'transient' AND (SELECT MAX(ended_at) FROM runs WHERE runs.routine_id = r.id) <= ?2) \
               OR (r.state = 'draft' AND EXISTS (SELECT 1 FROM routine_drafts d WHERE d.routine_id = r.id \
                   AND d.status = 'abandoned' AND d.updated_at <= ?3))) \
             ORDER BY r.id LIMIT ?5",
            params![when.deleted_by, when.once_by, when.draft_by, after, limit],
            |r| {
                Ok(LeavingRoutine {
                    id: r.get(0).map_err(failed)?,
                    name: r.get(1).map_err(failed)?,
                    state: wire_word(r, 2).map_err(failed)?,
                })
            },
        )
    }

    fn workers_of(&self, routine_id: &str) -> Result<Vec<String>, Error> {
        self.rows(
            "SELECT s.worker_id FROM routine_sessions s JOIN workers w ON w.id = s.worker_id \
             WHERE s.routine_id = ?1 ORDER BY s.worker_id",
            [routine_id],
            |r| r.get(0).map_err(failed),
        )
    }

    fn delete_runs_of(&self, routine_id: &str, limit: i64) -> Result<usize, Error> {
        let ids: Vec<String> = self.rows(
            "SELECT id FROM runs WHERE routine_id = ?1 ORDER BY id LIMIT ?2",
            params![routine_id, limit],
            |r| r.get(0).map_err(failed),
        )?;
        let mut deleted = 0;
        for id in &ids {
            deleted += self.drop_run(id, false)?;
        }
        Ok(deleted)
    }

    fn delete_routine(&self, routine_id: &str) -> Result<(), Error> {
        for table in [
            "inbox_deliveries",
            "inbox_edits",
            "inbox_outcomes",
            "inbox_offers",
            "routine_sessions",
            "routine_spend",
            "routine_drafts",
            "routine_versions",
            "signal_routes",
            "signal_schedules",
            "signal_runners",
        ] {
            self.exec(&format!("DELETE FROM {table} WHERE routine_id = ?1"), [routine_id])?;
        }
        self.exec("DELETE FROM routines WHERE id = ?1", [routine_id]).map(drop)
    }
}
