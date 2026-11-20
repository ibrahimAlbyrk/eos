//! The `signal_routes` rows the model's stage of Which reads: decisions
//! that wait for the model, and how often a routine's question was asked.

use eos_core::Error;
use eos_core::store::{SignalAskRepo, StoredSignalRoute};
use eos_kit_sqlite::rusqlite::params;

use crate::signals::{ROUTE_COLUMNS, route};
use crate::tx::{SqliteTx, failed};

impl SignalAskRepo for SqliteTx<'_> {
    fn waiting_asks(&self, reasons: &[&str], limit: i64) -> Result<Vec<StoredSignalRoute>, Error> {
        let reasons = serde_json::to_string(reasons).map_err(|e| Error::Storage(e.to_string()))?;
        self.rows(
            &format!(
                "SELECT {ROUTE_COLUMNS} FROM signal_routes WHERE decision = 'undecided' \
                 AND reason IN (SELECT value FROM json_each(?1)) ORDER BY decided_at, signal_id LIMIT ?2"
            ),
            params![reasons, limit],
            route,
        )
    }

    fn asked_since(&self, routine_id: &str, since: i64) -> Result<i64, Error> {
        self.row(
            "SELECT COUNT(*) FROM signal_routes WHERE routine_id = ?1 AND model_asked = 1 AND decided_at >= ?2",
            params![routine_id, since],
            |r| r.get(0).map_err(failed),
        )
        .map(Option::unwrap_or_default)
    }
}
