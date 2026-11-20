//! Clearing old rows of `signals`, their `signal_routes` and stopped
//! `signal_sources`. A signal counts as taken while a route of it names a
//! run that is still in `runs`.

use eos_core::Error;
use eos_core::store::SignalRetentionRepo;
use eos_kit_sqlite::rusqlite::params;

use crate::tx::{SqliteTx, failed};

/// The signal `s` has a decision whose run still exists.
const TAKEN: &str = "EXISTS (SELECT 1 FROM signal_routes r JOIN runs ON runs.id = r.run_id WHERE r.signal_id = s.id)";

impl SignalRetentionRepo for SqliteTx<'_> {
    fn clear_facts(&self, before: i64, limit: i64) -> Result<usize, Error> {
        self.exec(
            &format!(
                "UPDATE signals SET facts_json = NULL WHERE id IN (SELECT s.id FROM signals s \
                 WHERE s.received_at < ?1 AND s.facts_json IS NOT NULL AND NOT {TAKEN} ORDER BY s.id LIMIT ?2)"
            ),
            params![before, limit],
        )
    }

    fn unrun_before(&self, before: i64, limit: i64) -> Result<Vec<i64>, Error> {
        self.rows(
            &format!("SELECT s.id FROM signals s WHERE s.received_at < ?1 AND NOT {TAKEN} ORDER BY s.id LIMIT ?2"),
            params![before, limit],
            |r| r.get(0).map_err(failed),
        )
    }

    fn delete(&self, ids: &[i64]) -> Result<usize, Error> {
        let mut deleted = 0;
        for id in ids {
            self.exec("DELETE FROM signal_routes WHERE signal_id = ?1", [id])?;
            deleted += self.exec("DELETE FROM signals WHERE id = ?1", [id])?;
        }
        Ok(deleted)
    }

    fn count(&self) -> Result<i64, Error> {
        self.row("SELECT COUNT(*) FROM signals", [], |r| r.get(0).map_err(failed)).map(Option::unwrap_or_default)
    }

    fn delete_stopped_sources(&self, before: i64, limit: i64) -> Result<usize, Error> {
        self.exec(
            "DELETE FROM signal_sources WHERE id IN (SELECT id FROM signal_sources \
             WHERE state = 'stopped' AND stopped_at < ?1 LIMIT ?2)",
            params![before, limit],
        )
    }
}
