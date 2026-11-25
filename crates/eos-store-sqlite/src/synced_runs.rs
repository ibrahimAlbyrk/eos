//! `synced_runs`: summaries of runs the user's other computers finished.

use eos_core::Error;
use eos_core::store::{StoredSyncedRun, SyncedRunRepo};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str = "id, routine_id, device, ended_at, summary_json";

fn synced(r: &rusqlite::Row<'_>) -> Result<StoredSyncedRun, Error> {
    Ok(StoredSyncedRun {
        id: r.get(0).map_err(failed)?,
        routine_id: r.get(1).map_err(failed)?,
        device: r.get(2).map_err(failed)?,
        ended_at: r.get(3).map_err(failed)?,
        summary_json: r.get(4).map_err(failed)?,
    })
}

impl SyncedRunRepo for SqliteTx<'_> {
    fn put(&self, run: &StoredSyncedRun) -> Result<(), Error> {
        self.exec(
            &format!("INSERT OR REPLACE INTO synced_runs ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5)"),
            params![run.id, run.routine_id, run.device, run.ended_at, run.summary_json],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredSyncedRun>, Error> {
        self.row(&format!("SELECT {COLUMNS} FROM synced_runs WHERE id = ?1"), [id], synced)
    }

    fn delete(&self, id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM synced_runs WHERE id = ?1", [id]).map(drop)
    }

    fn ended_since(&self, routine_id: Option<&str>, since: i64, limit: i64) -> Result<Vec<StoredSyncedRun>, Error> {
        self.rows(
            &format!(
                "SELECT {COLUMNS} FROM synced_runs WHERE ended_at >= ?1 AND (?2 IS NULL OR routine_id = ?2) \
                 ORDER BY ended_at DESC, id LIMIT ?3"
            ),
            params![since, routine_id, limit],
            synced,
        )
    }

    fn prune(&self, before: i64) -> Result<usize, Error> {
        self.exec("DELETE FROM synced_runs WHERE ended_at < ?1", [before])
    }
}
