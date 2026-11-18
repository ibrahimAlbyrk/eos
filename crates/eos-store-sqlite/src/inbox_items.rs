//! `inbox_items`.

use eos_core::Error;
use eos_core::store::{InboxRepo, ItemAnswer, StoredItem};
use eos_domain::inbox::{Attention, ItemKind, ItemState};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known};

const ITEM_COLUMNS: &str = "id, kind, state, producer, routine_id, run_id, subject_key, title, summary, payload, \
                            working, rev, attention, stale_at, stale_reason, later_until, expires_at, created_at, \
                            updated_at, answered_at, answered_by, answer, replaced_by, consumed_at, notified_at";

fn item(r: &rusqlite::Row<'_>) -> Result<StoredItem, Error> {
    let read = || -> rusqlite::Result<StoredItem> {
        Ok(StoredItem {
            id: r.get(0)?,
            kind: known(r, 1, ItemKind::parse)?,
            state: known(r, 2, ItemState::parse)?,
            producer: r.get(3)?,
            routine_id: r.get(4)?,
            run_id: r.get(5)?,
            subject_key: r.get(6)?,
            title: r.get(7)?,
            summary: r.get(8)?,
            payload: r.get(9)?,
            working: r.get(10)?,
            rev: r.get(11)?,
            attention: known(r, 12, Attention::parse)?,
            stale_at: r.get(13)?,
            stale_reason: r.get(14)?,
            later_until: r.get(15)?,
            expires_at: r.get(16)?,
            created_at: r.get(17)?,
            updated_at: r.get(18)?,
            answered_at: r.get(19)?,
            answered_by: r.get(20)?,
            answer: r.get(21)?,
            replaced_by: r.get(22)?,
            consumed_at: r.get(23)?,
            notified_at: r.get(24)?,
        })
    };
    read().map_err(failed)
}

impl InboxRepo for SqliteTx<'_> {
    fn insert(&self, item: &StoredItem) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO inbox_items ({ITEM_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, \
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)"
            ),
            params![
                item.id,
                item.kind.as_str(),
                item.state.as_str(),
                item.producer,
                item.routine_id,
                item.run_id,
                item.subject_key,
                item.title,
                item.summary,
                item.payload,
                item.working,
                item.rev,
                item.attention.as_str(),
                item.stale_at,
                item.stale_reason,
                item.later_until,
                item.expires_at,
                item.created_at,
                item.updated_at,
                item.answered_at,
                item.answered_by,
                item.answer,
                item.replaced_by,
                item.consumed_at,
                item.notified_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredItem>, Error> {
        self.row(&format!("SELECT {ITEM_COLUMNS} FROM inbox_items WHERE id = ?1"), [id], item)
    }

    fn waiting(&self, limit: i64) -> Result<Vec<StoredItem>, Error> {
        self.rows(
            &format!(
                "SELECT {ITEM_COLUMNS} FROM inbox_items WHERE state IN ('open','later') \
                 ORDER BY state = 'later', \
                 CASE attention WHEN 'interrupt' THEN 0 WHEN 'digest' THEN 1 ELSE 2 END, \
                 created_at DESC, rowid DESC LIMIT ?1"
            ),
            [limit],
            item,
        )
    }

    fn answer(&self, id: &str, rev: i64, answer: &ItemAnswer) -> Result<bool, Error> {
        // One statement: of two answers on one rev, the second finds it changed.
        let changed = self.exec(
            "UPDATE inbox_items SET state = ?3, answered_at = ?4, answered_by = ?5, answer = ?6, rev = rev + 1, \
             updated_at = ?4 WHERE id = ?1 AND state IN ('open','later') AND rev = ?2",
            params![id, rev, ItemState::Answered.as_str(), answer.at, answer.by, answer.answer],
        )?;
        Ok(changed > 0)
    }
}
