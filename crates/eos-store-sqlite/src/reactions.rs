//! `message_reactions`.

use eos_contracts::ReactionActor;
use eos_core::Error;
use eos_core::store::{ReactionRepo, StoredReaction};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed};

const COLUMNS: &str = "event_id, worker_id, actor, emoji, told, created_at";

fn stored(r: &rusqlite::Row<'_>) -> Result<StoredReaction, Error> {
    let read = || -> rusqlite::Result<StoredReaction> {
        let actor: String = r.get(2)?;
        Ok(StoredReaction {
            event_id: r.get(0)?,
            worker_id: r.get(1)?,
            actor: if actor == "agent" { ReactionActor::Agent } else { ReactionActor::User },
            emoji: r.get(3)?,
            told: r.get(4)?,
            at: r.get(5)?,
        })
    };
    read().map_err(failed)
}

impl SqliteTx<'_> {
    /// A row with no emoji and nothing told says nothing any more.
    fn drop_if_empty(&self, event_id: i64, actor: ReactionActor) -> Result<(), Error> {
        self.exec(
            "DELETE FROM message_reactions WHERE event_id = ?1 AND actor = ?2 AND emoji IS NULL AND told IS NULL",
            params![event_id, actor.as_str()],
        )
        .map(drop)
    }

    /// The reactions on messages the log's bound just cut off.
    pub(crate) fn unreact_pruned(&self, worker_id: &str) -> Result<(), Error> {
        self.exec(
            "DELETE FROM message_reactions WHERE worker_id = ?1 \
             AND event_id < COALESCE((SELECT MIN(id) FROM events WHERE worker_id = ?1), 0)",
            [worker_id],
        )
        .map(drop)
    }
}

impl ReactionRepo for SqliteTx<'_> {
    fn find(&self, event_id: i64, actor: ReactionActor) -> Result<Option<StoredReaction>, Error> {
        self.row(
            &format!("SELECT {COLUMNS} FROM message_reactions WHERE event_id = ?1 AND actor = ?2"),
            params![event_id, actor.as_str()],
            stored,
        )
    }

    fn set(
        &self,
        worker_id: &str,
        event_id: i64,
        actor: ReactionActor,
        emoji: Option<&str>,
        now: i64,
    ) -> Result<(), Error> {
        self.exec(
            "INSERT INTO message_reactions (event_id, actor, worker_id, emoji, told, created_at) \
             VALUES (?1, ?2, ?3, ?4, NULL, ?5) \
             ON CONFLICT(event_id, actor) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at",
            params![event_id, actor.as_str(), worker_id, emoji, now],
        )?;
        self.drop_if_empty(event_id, actor)
    }

    fn list(&self, worker_id: &str, from_id: i64, to_id: i64, limit: i64) -> Result<Vec<StoredReaction>, Error> {
        self.rows(
            &format!(
                "SELECT {COLUMNS} FROM message_reactions WHERE worker_id = ?1 AND event_id BETWEEN ?2 AND ?3 \
                 AND emoji IS NOT NULL ORDER BY event_id ASC, actor DESC LIMIT ?4"
            ),
            params![worker_id, from_id, to_id, limit],
            stored,
        )
    }

    fn untold(&self, worker_id: &str, limit: i64) -> Result<Vec<StoredReaction>, Error> {
        let mut newest = self.rows(
            &format!(
                "SELECT {COLUMNS} FROM message_reactions WHERE worker_id = ?1 AND actor = 'user' \
                 AND emoji IS NOT told ORDER BY event_id DESC LIMIT ?2"
            ),
            params![worker_id, limit],
            stored,
        )?;
        newest.reverse();
        Ok(newest)
    }

    fn set_told(&self, event_id: i64, told: Option<&str>) -> Result<(), Error> {
        self.exec(
            "UPDATE message_reactions SET told = ?2 WHERE event_id = ?1 AND actor = 'user'",
            params![event_id, told],
        )?;
        self.drop_if_empty(event_id, ReactionActor::User)
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM message_reactions WHERE worker_id = ?1", [worker_id]).map(drop)
    }

    fn sweep_orphans(&self) -> Result<usize, Error> {
        self.exec(
            "DELETE FROM message_reactions WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.id = event_id)",
            [],
        )
    }
}
