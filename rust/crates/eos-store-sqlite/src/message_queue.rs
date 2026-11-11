//! `queued_messages` (`infra/src/persistence/SqliteMessageQueueRepo.ts`).

use eos_core::Error;
use eos_core::store::{MessageQueueRepo, NewQueuedMessage};
use eos_domain::message_queue::{QueueMeta, QueuedMessage};
use eos_kit_sqlite::rusqlite::{Row, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str = "id, worker_id, client_msg_id, text, created_at, meta";

fn queued(row: &Row<'_>) -> Result<QueuedMessage, Error> {
    let read = || -> eos_kit_sqlite::rusqlite::Result<(QueuedMessage, Option<String>)> {
        let message = QueuedMessage {
            id: row.get(0)?,
            worker_id: row.get(1)?,
            client_msg_id: row.get(2)?,
            text: row.get(3)?,
            created_at: row.get(4)?,
            meta: QueueMeta::default(),
        };
        Ok((message, row.get(5)?))
    };
    let (mut message, meta) = read().map_err(failed)?;
    // Metadata that no longer parses is dropped: the text still gets delivered.
    message.meta = meta.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
    Ok(message)
}

impl SqliteTx<'_> {
    fn pending_messages(&self, worker_id: &str, only_user: bool) -> Result<Vec<QueuedMessage>, Error> {
        let plane = if only_user { " AND plane = 'user'" } else { "" };
        let sql = format!(
            "SELECT {COLUMNS} FROM queued_messages WHERE worker_id = ?1 AND dispatched_at IS NULL{plane} ORDER BY id ASC"
        );
        self.rows(&sql, [worker_id], queued)
    }
}

impl MessageQueueRepo for SqliteTx<'_> {
    fn insert(&self, new: &NewQueuedMessage) -> Result<Option<i64>, Error> {
        let meta =
            if new.meta.is_empty() { None } else { Some(serde_json::to_string(&new.meta).map_err(Error::storage)?) };
        let inserted = self.exec(
            "INSERT INTO queued_messages (worker_id, client_msg_id, text, created_at, dispatched_at, meta, plane) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(worker_id, client_msg_id) DO NOTHING",
            params![
                new.worker_id,
                new.client_msg_id,
                new.text,
                new.created_at,
                new.dispatched_at,
                meta,
                new.plane.name()
            ],
        )?;
        Ok((inserted > 0).then(|| self.conn.last_insert_rowid()))
    }

    fn list_pending(&self, worker_id: &str) -> Result<Vec<QueuedMessage>, Error> {
        self.pending_messages(worker_id, false)
    }

    fn list_pending_user_plane(&self, worker_id: &str) -> Result<Vec<QueuedMessage>, Error> {
        self.pending_messages(worker_id, true)
    }

    fn mark_dispatched(&self, ids: &[i64], ts: i64) -> Result<(), Error> {
        for id in ids {
            self.exec("UPDATE queued_messages SET dispatched_at = ?1 WHERE id = ?2", params![ts, id])?;
        }
        Ok(())
    }

    fn remove_by_id(&self, id: i64) -> Result<(), Error> {
        self.exec("DELETE FROM queued_messages WHERE id = ?1", [id]).map(drop)
    }

    fn remove_dispatched_by_client_msg_id(&self, worker_id: &str, client_msg_id: &str) -> Result<(), Error> {
        self.exec(
            "DELETE FROM queued_messages WHERE worker_id = ?1 AND client_msg_id = ?2 AND dispatched_at IS NOT NULL",
            [worker_id, client_msg_id],
        )
        .map(drop)
    }

    fn remove_pending(&self, worker_id: &str, id: i64) -> Result<bool, Error> {
        let removed = self.exec(
            "DELETE FROM queued_messages WHERE worker_id = ?1 AND id = ?2 AND dispatched_at IS NULL",
            params![worker_id, id],
        )?;
        Ok(removed > 0)
    }

    fn clear_pending(&self, worker_id: &str) -> Result<usize, Error> {
        self.exec("DELETE FROM queued_messages WHERE worker_id = ?1 AND dispatched_at IS NULL", [worker_id])
    }

    fn clear_pending_user_plane(&self, worker_id: &str) -> Result<usize, Error> {
        self.exec(
            "DELETE FROM queued_messages WHERE worker_id = ?1 AND plane = 'user' AND dispatched_at IS NULL",
            [worker_id],
        )
    }

    fn has_recent_dispatch(&self, worker_id: &str, text: &str, since: i64) -> Result<bool, Error> {
        let hit = self.row(
            "SELECT 1 FROM queued_messages WHERE worker_id = ?1 AND text = ?2 AND dispatched_at > ?3 LIMIT 1",
            params![worker_id, text, since],
            |_| Ok(()),
        )?;
        Ok(hit.is_some())
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM queued_messages WHERE worker_id = ?1", [worker_id]).map(drop)
    }

    fn prune(&self, before: i64) -> Result<(), Error> {
        self.exec("DELETE FROM queued_messages WHERE dispatched_at IS NOT NULL AND dispatched_at < ?1", [before])
            .map(drop)
    }
}
