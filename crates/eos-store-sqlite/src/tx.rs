//! One connection's view of every repository.

use std::collections::HashMap;
use std::sync::Mutex;

use eos_core::Error;
use eos_core::store::{
    ContextMarkRepo, ConversationListRepo, DreamRepo, EventRepo, GenuiViewRepo, MessageIdRepo, MessageQueueRepo,
    PendingRepo, TransferRepo, Tx, WorkerDefinitionRepo, WorkerRepo, WorktreeRemovalQueue,
};
use eos_kit_sqlite::rusqlite::{self, Connection};

/// What outlives a single job.
pub(crate) struct Shared {
    /// Each worker keeps its newest this-many events; 0 keeps them all.
    pub(crate) events_max_per_worker: i64,
    /// Appends per worker since its last prune.
    pub(crate) appends_since_prune: Mutex<HashMap<String, u32>>,
}

pub(crate) struct SqliteTx<'c> {
    pub(crate) conn: &'c Connection,
    pub(crate) shared: &'c Shared,
}

/// Every repository is this one struct: a job reads and writes through any of
/// them inside the same transaction.
impl Tx for SqliteTx<'_> {
    fn context_marks(&self) -> &dyn ContextMarkRepo {
        self
    }

    fn conversation_lists(&self) -> &dyn ConversationListRepo {
        self
    }

    fn dreams(&self) -> &dyn DreamRepo {
        self
    }

    fn events(&self) -> &dyn EventRepo {
        self
    }

    fn genui_views(&self) -> &dyn GenuiViewRepo {
        self
    }

    fn message_ids(&self) -> &dyn MessageIdRepo {
        self
    }

    fn message_queue(&self) -> &dyn MessageQueueRepo {
        self
    }

    fn pending(&self) -> &dyn PendingRepo {
        self
    }

    fn transfers(&self) -> &dyn TransferRepo {
        self
    }

    fn worker_definitions(&self) -> &dyn WorkerDefinitionRepo {
        self
    }

    fn workers(&self) -> &dyn WorkerRepo {
        self
    }

    fn worktree_removals(&self) -> &dyn WorktreeRemovalQueue {
        self
    }
}

/// A database failure in the ports' vocabulary.
pub(crate) fn failed(e: rusqlite::Error) -> Error {
    Error::Storage(format!("sqlite: {e}"))
}

impl SqliteTx<'_> {
    /// Runs a statement that returns no rows; answers how many it changed.
    pub(crate) fn exec(&self, sql: &str, params: impl rusqlite::Params) -> Result<usize, Error> {
        self.conn.prepare_cached(sql).and_then(|mut stmt| stmt.execute(params)).map_err(failed)
    }

    /// Every row of a query, mapped.
    pub(crate) fn rows<T>(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
        map: impl Fn(&rusqlite::Row<'_>) -> Result<T, Error>,
    ) -> Result<Vec<T>, Error> {
        let mut stmt = self.conn.prepare_cached(sql).map_err(failed)?;
        let mut rows = stmt.query(params).map_err(failed)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(failed)? {
            out.push(map(row)?);
        }
        Ok(out)
    }

    /// The first row of a query, mapped.
    pub(crate) fn row<T>(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
        map: impl Fn(&rusqlite::Row<'_>) -> Result<T, Error>,
    ) -> Result<Option<T>, Error> {
        let mut stmt = self.conn.prepare_cached(sql).map_err(failed)?;
        let mut rows = stmt.query(params).map_err(failed)?;
        rows.next().map_err(failed)?.map(map).transpose()
    }
}
