//! `inbox_items`.

use eos_core::Error;
use eos_core::store::{InboxRepo, ItemAnswer, ItemQuery, StoredItem, WaitingCount};
use eos_domain::inbox::{Attention, ItemKind, ItemState};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known};

/// `eos_domain::inbox::order_rank`, in SQL.
const RANK: &str = "(CASE state WHEN 'later' THEN 3 ELSE 0 END + \
                    CASE attention WHEN 'interrupt' THEN 0 WHEN 'digest' THEN 1 ELSE 2 END)";

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

    fn retell(&self, item: &StoredItem, rev: i64) -> Result<bool, Error> {
        let changed = self.exec(
            "UPDATE inbox_items SET title = ?3, summary = ?4, payload = ?5, rev = ?6, updated_at = ?7 \
             WHERE id = ?1 AND rev = ?2 AND state IN ('open','later')",
            params![item.id, rev, item.title, item.summary, item.payload, item.rev, item.updated_at],
        )?;
        Ok(changed == 1)
    }

    fn update_waiting(&self, item: &StoredItem, rev: i64) -> Result<bool, Error> {
        let changed = self.exec(
            "UPDATE inbox_items SET state = ?3, working = ?4, rev = ?5, stale_at = ?6, stale_reason = ?7, \
             later_until = ?8, updated_at = ?9, answered_at = ?10, answered_by = ?11, answer = ?12, \
             replaced_by = ?13 WHERE id = ?1 AND rev = ?2 AND state IN ('open','later')",
            params![
                item.id,
                rev,
                item.state.as_str(),
                item.working,
                item.rev,
                item.stale_at,
                item.stale_reason,
                item.later_until,
                item.updated_at,
                item.answered_at,
                item.answered_by,
                item.answer,
                item.replaced_by,
            ],
        )?;
        Ok(changed > 0)
    }

    fn page(&self, query: &ItemQuery) -> Result<Vec<StoredItem>, Error> {
        let state = query.state.map(ItemState::as_str);
        let (rank, created_at, id) = match &query.after {
            Some(place) => (place.rank, place.created_at, Some(place.id.as_str())),
            None => (-1, 0, None),
        };
        self.rows(
            &format!(
                "SELECT {ITEM_COLUMNS} FROM inbox_items \
                 WHERE (CASE WHEN ?1 IS NULL THEN state IN ('open','later') ELSE state = ?1 END) \
                 AND (?2 IS NULL OR routine_id = ?2) \
                 AND (?5 IS NULL OR {RANK} > ?3 OR ({RANK} = ?3 AND (created_at < ?4 \
                      OR (created_at = ?4 AND id < ?5)))) \
                 ORDER BY {RANK}, created_at DESC, id DESC LIMIT ?6"
            ),
            params![state, query.routine_id, rank, created_at, id, query.limit],
            item,
        )
    }

    fn counts(&self) -> Result<Vec<WaitingCount>, Error> {
        self.rows(
            "SELECT state, kind, routine_id, COUNT(*) FROM inbox_items WHERE state IN ('open','later') \
             GROUP BY state, kind, routine_id ORDER BY state, kind, routine_id",
            [],
            |r| {
                let read = || -> rusqlite::Result<WaitingCount> {
                    Ok(WaitingCount {
                        state: known(r, 0, ItemState::parse)?,
                        kind: known(r, 1, ItemKind::parse)?,
                        routine_id: r.get(2)?,
                        count: r.get(3)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }

    fn open_count(&self) -> Result<i64, Error> {
        let count = self
            .row("SELECT COUNT(*) FROM inbox_items WHERE state = 'open'", [], |r| r.get::<_, i64>(0).map_err(failed))?;
        Ok(count.unwrap_or(0))
    }

    fn waiting_of_routine(&self, routine_id: &str) -> Result<Vec<StoredItem>, Error> {
        self.rows(
            &format!(
                "SELECT {ITEM_COLUMNS} FROM inbox_items WHERE routine_id = ?1 AND state IN ('open','later') \
                 ORDER BY created_at, rowid"
            ),
            [routine_id],
            item,
        )
    }

    fn waiting_with_subject(&self, subject_key: &str) -> Result<Vec<StoredItem>, Error> {
        self.rows(
            &format!(
                "SELECT {ITEM_COLUMNS} FROM inbox_items WHERE subject_key = ?1 AND state IN ('open','later') \
                 ORDER BY created_at, rowid"
            ),
            [subject_key],
            item,
        )
    }

    fn unconsumed(&self, producer: &str) -> Result<Vec<StoredItem>, Error> {
        self.rows(
            &format!(
                "SELECT {ITEM_COLUMNS} FROM inbox_items WHERE producer = ?1 AND state = 'answered' \
                 AND consumed_at IS NULL ORDER BY answered_at, rowid"
            ),
            [producer],
            item,
        )
    }

    fn consume(&self, id: &str, at: i64) -> Result<bool, Error> {
        let changed = self.exec(
            "UPDATE inbox_items SET consumed_at = ?2 WHERE id = ?1 AND state = 'answered' AND consumed_at IS NULL",
            params![id, at],
        )?;
        Ok(changed > 0)
    }

    fn reopen(&self, id: &str, at: i64) -> Result<bool, Error> {
        let changed = self.exec(
            "UPDATE inbox_items SET state = 'open', rev = rev + 1, updated_at = ?2, answered_at = NULL, \
             answered_by = NULL, answer = NULL, consumed_at = NULL WHERE id = ?1 AND state = 'answered'",
            params![id, at],
        )?;
        Ok(changed > 0)
    }

    fn delete_ended_before(&self, before: i64, limit: i64) -> Result<usize, Error> {
        self.exec(
            "DELETE FROM inbox_items WHERE rowid IN (SELECT rowid FROM inbox_items \
             WHERE state NOT IN ('open','later') AND updated_at < ?1 LIMIT ?2)",
            params![before, limit],
        )
    }
}
