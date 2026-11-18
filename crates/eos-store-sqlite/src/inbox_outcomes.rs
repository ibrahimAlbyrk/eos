//! `inbox_edits`, `inbox_outcomes` and `inbox_offers`: what the user did
//! with results, and the freedom that earns a routine.

use eos_core::Error;
use eos_core::store::{EditRepo, NewEdit, NewOutcome, OfferRepo, OutcomeRepo, StoredEdit, StoredOffer, StoredOutcome};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed};

const EDIT_COLUMNS: &str = "id, item_id, delivery_id, routine_id, run_id, result_kind, before, after, ops, changed, \
                            removed, added, moved, derived_from_untrusted, at";

fn edit(r: &rusqlite::Row<'_>) -> Result<StoredEdit, Error> {
    let read = || -> rusqlite::Result<StoredEdit> {
        Ok(StoredEdit {
            id: r.get(0)?,
            edit: NewEdit {
                item_id: r.get(1)?,
                delivery_id: r.get(2)?,
                routine_id: r.get(3)?,
                run_id: r.get(4)?,
                result_kind: r.get(5)?,
                before: r.get(6)?,
                after: r.get(7)?,
                ops: r.get(8)?,
                changed: r.get(9)?,
                removed: r.get(10)?,
                added: r.get(11)?,
                moved: r.get(12)?,
                derived_from_untrusted: r.get(13)?,
                at: r.get(14)?,
            },
        })
    };
    read().map_err(failed)
}

const OUTCOME_COLUMNS: &str = "id, routine_id, run_id, item_id, delivery_id, outcome, rung, at";

fn outcome(r: &rusqlite::Row<'_>) -> Result<StoredOutcome, Error> {
    let read = || -> rusqlite::Result<StoredOutcome> {
        Ok(StoredOutcome {
            id: r.get(0)?,
            outcome: NewOutcome {
                routine_id: r.get(1)?,
                run_id: r.get(2)?,
                item_id: r.get(3)?,
                delivery_id: r.get(4)?,
                outcome: r.get(5)?,
                rung: r.get(6)?,
                at: r.get(7)?,
            },
        })
    };
    read().map_err(failed)
}

const OFFER_COLUMNS: &str = "routine_id, state, item_id, streak_at, next_at, updated_at";

fn offer(r: &rusqlite::Row<'_>) -> Result<StoredOffer, Error> {
    let read = || -> rusqlite::Result<StoredOffer> {
        Ok(StoredOffer {
            routine_id: r.get(0)?,
            state: r.get(1)?,
            item_id: r.get(2)?,
            streak_at: r.get(3)?,
            next_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    };
    read().map_err(failed)
}

impl EditRepo for SqliteTx<'_> {
    fn insert(&self, edit: &NewEdit) -> Result<i64, Error> {
        self.exec(
            "INSERT INTO inbox_edits (item_id, delivery_id, routine_id, run_id, result_kind, before, after, ops, \
             changed, removed, added, moved, derived_from_untrusted, at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                edit.item_id,
                edit.delivery_id,
                edit.routine_id,
                edit.run_id,
                edit.result_kind,
                edit.before,
                edit.after,
                edit.ops,
                edit.changed,
                edit.removed,
                edit.added,
                edit.moved,
                edit.derived_from_untrusted,
                edit.at,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn find(&self, id: i64) -> Result<Option<StoredEdit>, Error> {
        self.row(&format!("SELECT {EDIT_COLUMNS} FROM inbox_edits WHERE id = ?1"), [id], edit)
    }

    fn since(&self, cursor: i64, limit: i64) -> Result<Vec<StoredEdit>, Error> {
        self.rows(
            &format!("SELECT {EDIT_COLUMNS} FROM inbox_edits WHERE id > ?1 ORDER BY id LIMIT ?2"),
            params![cursor, limit],
            edit,
        )
    }
}

impl OutcomeRepo for SqliteTx<'_> {
    fn insert(&self, outcome: &NewOutcome) -> Result<i64, Error> {
        self.exec(
            "INSERT INTO inbox_outcomes (routine_id, run_id, item_id, delivery_id, outcome, rung, at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                outcome.routine_id,
                outcome.run_id,
                outcome.item_id,
                outcome.delivery_id,
                outcome.outcome,
                outcome.rung,
                outcome.at,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn by_routine(&self, routine_id: &str, limit: i64) -> Result<Vec<StoredOutcome>, Error> {
        self.rows(
            &format!(
                "SELECT {OUTCOME_COLUMNS} FROM inbox_outcomes WHERE routine_id = ?1 ORDER BY at DESC, id DESC \
                 LIMIT ?2"
            ),
            params![routine_id, limit],
            outcome,
        )
    }
}

impl OfferRepo for SqliteTx<'_> {
    fn put(&self, offer: &StoredOffer) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO inbox_offers ({OFFER_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT (routine_id) DO UPDATE SET state = excluded.state, item_id = excluded.item_id, \
                 streak_at = excluded.streak_at, next_at = excluded.next_at, updated_at = excluded.updated_at"
            ),
            params![offer.routine_id, offer.state, offer.item_id, offer.streak_at, offer.next_at, offer.updated_at],
        )
        .map(drop)
    }

    fn find(&self, routine_id: &str) -> Result<Option<StoredOffer>, Error> {
        self.row(&format!("SELECT {OFFER_COLUMNS} FROM inbox_offers WHERE routine_id = ?1"), [routine_id], offer)
    }
}
