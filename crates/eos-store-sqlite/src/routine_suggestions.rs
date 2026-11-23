//! `routine_suggestions`: the tasks Eos offered as routines.

use eos_core::Error;
use eos_core::store::{RoutineSuggestionRepo, StoredSuggestion};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str = "key, state, inbox_id, created_at";

fn suggestion(r: &rusqlite::Row<'_>) -> Result<StoredSuggestion, Error> {
    let read = || -> rusqlite::Result<StoredSuggestion> {
        Ok(StoredSuggestion { key: r.get(0)?, state: r.get(1)?, inbox_id: r.get(2)?, created_at: r.get(3)? })
    };
    read().map_err(failed)
}

impl RoutineSuggestionRepo for SqliteTx<'_> {
    fn insert(&self, s: &StoredSuggestion) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO routine_suggestions ({COLUMNS}) VALUES (?1, ?2, ?3, ?4)"),
            params![s.key, s.state, s.inbox_id, s.created_at],
        )
        .map(drop)
    }

    fn find(&self, key: &str) -> Result<Option<StoredSuggestion>, Error> {
        self.row(&format!("SELECT {COLUMNS} FROM routine_suggestions WHERE key = ?1"), [key], suggestion)
    }

    fn list(&self) -> Result<Vec<StoredSuggestion>, Error> {
        self.rows(&format!("SELECT {COLUMNS} FROM routine_suggestions ORDER BY created_at DESC, key"), [], suggestion)
    }

    fn set_state(&self, key: &str, state: &str) -> Result<(), Error> {
        self.exec("UPDATE routine_suggestions SET state = ?2 WHERE key = ?1", params![key, state]).map(drop)
    }
}
