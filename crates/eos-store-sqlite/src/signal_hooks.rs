//! `signal_hooks`: which source each hook of the relay's inbox wakes.

use eos_core::Error;
use eos_core::store::SignalHookRepo;
use eos_kit_sqlite::rusqlite::params;

use crate::tx::{SqliteTx, failed};

impl SignalHookRepo for SqliteTx<'_> {
    fn insert(&self, hook_id: &str, source_id: &str, created_at: i64) -> Result<(), Error> {
        self.exec(
            "INSERT INTO signal_hooks (hook_id, source_id, created_at) VALUES (?1, ?2, ?3)",
            params![hook_id, source_id, created_at],
        )
        .map(drop)
    }

    fn source_of(&self, hook_id: &str) -> Result<Option<String>, Error> {
        self.row("SELECT source_id FROM signal_hooks WHERE hook_id = ?1", [hook_id], |r| r.get(0).map_err(failed))
    }

    fn hooked(&self) -> Result<Vec<String>, Error> {
        self.rows("SELECT DISTINCT source_id FROM signal_hooks ORDER BY source_id", params![], |r| {
            r.get(0).map_err(failed)
        })
    }
}
