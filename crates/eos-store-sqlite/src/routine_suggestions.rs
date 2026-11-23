//! `routine_suggestions`: the tasks Eos offered as routines; and
//! `routine_once_asks`: the one-offs made of each kind of task.

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

    fn note_once(&self, routine_id: &str, task_key: &str, at: i64) -> Result<(), Error> {
        self.exec(
            "INSERT INTO routine_once_asks (routine_id, task_key, created_at) VALUES (?1, ?2, ?3)",
            params![routine_id, task_key, at],
        )
        .map(drop)
    }

    fn onces_since(&self, task_key: &str, since: i64) -> Result<usize, Error> {
        let count: i64 = self
            .row(
                "SELECT COUNT(*) FROM routine_once_asks WHERE task_key = ?1 AND created_at >= ?2",
                params![task_key, since],
                |r| r.get(0).map_err(failed),
            )?
            .unwrap_or(0);
        Ok(usize::try_from(count).unwrap_or(0))
    }

    fn forget_onces(&self, before: i64) -> Result<usize, Error> {
        self.exec("DELETE FROM routine_once_asks WHERE created_at < ?1", [before])
    }
}
