//! `pending_permissions`.

use eos_core::Error;
use eos_core::store::{NewPending, PendingRepo};
use eos_domain::pending::PendingPermission;
use eos_kit_sqlite::rusqlite::{Row, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str =
    "id, worker_id, tool_name, input, created_at, expires_at, resolved, decision, reason, tool_use_id, updated_input";

fn pending(row: &Row<'_>) -> Result<PendingPermission, Error> {
    let read = || -> eos_kit_sqlite::rusqlite::Result<PendingPermission> {
        Ok(PendingPermission {
            id: row.get(0)?,
            worker_id: row.get(1)?,
            tool_name: row.get(2)?,
            input: row.get(3)?,
            created_at: row.get(4)?,
            expires_at: row.get(5)?,
            resolved: row.get::<_, i64>(6)? != 0,
            decision: row.get(7)?,
            reason: row.get(8)?,
            tool_use_id: row.get(9)?,
            updated_input: row.get(10)?,
        })
    };
    read().map_err(failed)
}

impl PendingRepo for SqliteTx<'_> {
    fn insert(&self, new: &NewPending) -> Result<(), Error> {
        self.exec(
            "INSERT INTO pending_permissions (id, worker_id, tool_name, input, tool_use_id, created_at, expires_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![new.id, new.worker_id, new.tool_name, new.input, new.tool_use_id, new.created_at, new.expires_at],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<PendingPermission>, Error> {
        self.row(&format!("SELECT {COLUMNS} FROM pending_permissions WHERE id = ?1"), [id], pending)
    }

    fn list_unresolved(&self) -> Result<Vec<PendingPermission>, Error> {
        let sql = format!("SELECT {COLUMNS} FROM pending_permissions WHERE resolved = 0 ORDER BY created_at ASC");
        self.rows(&sql, [], pending)
    }

    fn resolve(
        &self,
        id: &str,
        decision: &str,
        reason: Option<&str>,
        updated_input: Option<&str>,
    ) -> Result<bool, Error> {
        let changed = self.exec(
            "UPDATE pending_permissions SET resolved = 1, decision = ?1, reason = ?2, updated_input = ?3 \
             WHERE id = ?4 AND resolved = 0",
            params![decision, reason, updated_input, id],
        )?;
        Ok(changed > 0)
    }

    fn sweep_expired(&self, now: i64, reason: &str) -> Result<usize, Error> {
        self.exec(
            "UPDATE pending_permissions SET resolved = 1, decision = 'deny', reason = ?1 \
             WHERE resolved = 0 AND expires_at < ?2",
            params![reason, now],
        )
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM pending_permissions WHERE worker_id = ?1", [worker_id]).map(drop)
    }
}
