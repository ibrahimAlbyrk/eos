//! The `signal_routes` rows the model's stage of Which reads: decisions
//! that wait for the model, and how often a routine's question was asked.

use eos_core::Error;
use eos_core::store::{SignalAskRepo, StoredSignalRoute};
use eos_kit_sqlite::rusqlite::params;

use crate::signals::{ROUTE_COLUMNS, route};
use crate::tx::{SqliteTx, failed};

impl SignalAskRepo for SqliteTx<'_> {
    fn waiting_asks(
        &self,
        routine_ids: &[&str],
        reasons: &[&str],
        limit: i64,
    ) -> Result<Vec<StoredSignalRoute>, Error> {
        let json = |list: &[&str]| serde_json::to_string(list).map_err(|e| Error::Storage(e.to_string()));
        self.rows(
            &format!(
                "SELECT {ROUTE_COLUMNS} FROM signal_routes WHERE decision = 'undecided' \
                 AND routine_id IN (SELECT value FROM json_each(?1)) \
                 AND reason IN (SELECT value FROM json_each(?2)) \
                 ORDER BY (SELECT key FROM json_each(?2) WHERE value = reason), decided_at, signal_id LIMIT ?3"
            ),
            params![json(routine_ids)?, json(reasons)?, limit],
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
