//! `worker_message_ids`, `worker_context_marks`, `pending_worktree_removals`.

use eos_core::Error;
use eos_core::store::{ContextMarkRepo, MessageIdRepo, WorktreeRemoval, WorktreeRemovalQueue};
use eos_kit_sqlite::rusqlite::params;

use crate::tx::{SqliteTx, failed};

impl SqliteTx<'_> {
    fn message_counters(&self, worker_id: &str) -> Result<(i64, i64), Error> {
        let found = self.row("SELECT seq, sub FROM worker_message_ids WHERE worker_id = ?1", [worker_id], |r| {
            Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?))
        })?;
        Ok(found.unwrap_or((0, 0)))
    }
}

impl MessageIdRepo for SqliteTx<'_> {
    fn next_inbound(&self, worker_id: &str) -> Result<i64, Error> {
        self.exec(
            "INSERT INTO worker_message_ids (worker_id, seq, sub) VALUES (?1, 1, 0) \
             ON CONFLICT(worker_id) DO UPDATE SET seq = seq + 1, sub = 0",
            [worker_id],
        )?;
        Ok(self.message_counters(worker_id)?.0)
    }

    fn next_assistant(&self, worker_id: &str) -> Result<String, Error> {
        self.exec(
            "INSERT INTO worker_message_ids (worker_id, seq, sub) VALUES (?1, 0, 1) \
             ON CONFLICT(worker_id) DO UPDATE SET sub = sub + 1",
            [worker_id],
        )?;
        let (seq, sub) = self.message_counters(worker_id)?;
        Ok(format!("{seq}.{sub}"))
    }

    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_message_ids WHERE worker_id = ?1", [worker_id]).map(drop)
    }
}

impl ContextMarkRepo for SqliteTx<'_> {
    fn mark(&self, worker_id: &str, stage: &str, now: i64) -> Result<bool, Error> {
        let inserted = self.exec(
            "INSERT INTO worker_context_marks (worker_id, stage, marked_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(worker_id, stage) DO NOTHING",
            params![worker_id, stage, now],
        )?;
        Ok(inserted == 1)
    }

    fn clear(&self, worker_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_context_marks WHERE worker_id = ?1", [worker_id]).map(drop)
    }

    fn has(&self, worker_id: &str, stage: &str) -> Result<bool, Error> {
        let hit = self.row(
            "SELECT 1 FROM worker_context_marks WHERE worker_id = ?1 AND stage = ?2 LIMIT 1",
            [worker_id, stage],
            |_| Ok(()),
        )?;
        Ok(hit.is_some())
    }
}

impl WorktreeRemovalQueue for SqliteTx<'_> {
    fn enqueue(&self, e: &WorktreeRemoval) -> Result<(), Error> {
        self.exec(
            "INSERT INTO pending_worktree_removals (id, worker_id, repo_root, worktree_dir, branch, scheduled_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, repo_root = excluded.repo_root, \
               worktree_dir = excluded.worktree_dir, branch = excluded.branch, scheduled_at = excluded.scheduled_at",
            params![e.id, e.worker_id, e.repo_root, e.worktree_dir, e.branch, e.scheduled_at],
        )
        .map(drop)
    }

    fn list(&self) -> Result<Vec<WorktreeRemoval>, Error> {
        self.rows(
            "SELECT id, worker_id, repo_root, worktree_dir, branch, scheduled_at FROM pending_worktree_removals \
             ORDER BY scheduled_at ASC",
            [],
            |r| {
                let read = || -> eos_kit_sqlite::rusqlite::Result<WorktreeRemoval> {
                    Ok(WorktreeRemoval {
                        id: r.get(0)?,
                        worker_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        repo_root: r.get(2)?,
                        worktree_dir: r.get(3)?,
                        branch: r.get(4)?,
                        scheduled_at: r.get(5)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }

    fn delete(&self, id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM pending_worktree_removals WHERE id = ?1", [id]).map(drop)
    }
}
