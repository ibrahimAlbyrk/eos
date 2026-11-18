//! One connection's view of every repository.

use std::collections::HashMap;
use std::sync::Mutex;

use eos_core::Error;
use eos_core::store::{
    ContextMarkRepo, ConversationListRepo, DeliveryRepo, DreamRepo, EditRepo, EventRepo, GenuiViewRepo, HaltRepo,
    InboxRepo, MessageIdRepo, MessageQueueRepo, OfferRepo, OutcomeRepo, PendingRepo, ReactionRepo, RoutineRepo,
    RoutineSessionRepo, RoutineSpendRepo, RoutineVersionRepo, RunRepo, RunResultRepo, SignalRepo, SignalRouteRepo,
    SignalRunnerRepo, SignalScheduleRepo, SignalSourceRepo, TransferRepo, Tx, WorkerDefinitionRepo, WorkerRepo,
    WorktreeRemovalQueue,
};
use eos_kit_sqlite::rusqlite::{self, Connection};
use serde::Serialize;
use serde::de::DeserializeOwned;

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

    fn inbox_deliveries(&self) -> &dyn DeliveryRepo {
        self
    }

    fn inbox_edits(&self) -> &dyn EditRepo {
        self
    }

    fn inbox_halt(&self) -> &dyn HaltRepo {
        self
    }

    fn inbox_items(&self) -> &dyn InboxRepo {
        self
    }

    fn inbox_offers(&self) -> &dyn OfferRepo {
        self
    }

    fn inbox_outcomes(&self) -> &dyn OutcomeRepo {
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

    fn reactions(&self) -> &dyn ReactionRepo {
        self
    }

    fn routine_sessions(&self) -> &dyn RoutineSessionRepo {
        self
    }

    fn routine_spend(&self) -> &dyn RoutineSpendRepo {
        self
    }

    fn routine_versions(&self) -> &dyn RoutineVersionRepo {
        self
    }

    fn routines(&self) -> &dyn RoutineRepo {
        self
    }

    fn run_results(&self) -> &dyn RunResultRepo {
        self
    }

    fn runs(&self) -> &dyn RunRepo {
        self
    }

    fn signal_routes(&self) -> &dyn SignalRouteRepo {
        self
    }

    fn signal_runners(&self) -> &dyn SignalRunnerRepo {
        self
    }

    fn signal_schedules(&self) -> &dyn SignalScheduleRepo {
        self
    }

    fn signal_sources(&self) -> &dyn SignalSourceRepo {
        self
    }

    fn signals(&self) -> &dyn SignalRepo {
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

/// The word a contracts enum is stored as: the one it is written as on the wire.
pub(crate) fn word<T: Serialize>(value: &T) -> Result<String, Error> {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(word)) => Ok(word),
        _ => Err(Error::Storage("a stored word is not a string".to_owned())),
    }
}

/// A word column read back; a word this version does not know fails the read.
pub(crate) fn known<T>(
    r: &rusqlite::Row<'_>,
    idx: usize,
    parse: impl FnOnce(&str) -> Option<T>,
) -> rusqlite::Result<T> {
    let text: String = r.get(idx)?;
    parse(&text).ok_or_else(|| unknown(idx, &text))
}

/// [`known`] for a column that may be NULL.
pub(crate) fn known_or_null<T>(
    r: &rusqlite::Row<'_>,
    idx: usize,
    parse: impl FnOnce(&str) -> Option<T>,
) -> rusqlite::Result<Option<T>> {
    let text: Option<String> = r.get(idx)?;
    text.map(|text| parse(&text).ok_or_else(|| unknown(idx, &text))).transpose()
}

/// [`known`] for a contracts enum.
pub(crate) fn wire_word<T: DeserializeOwned>(r: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<T> {
    known(r, idx, |text| serde_json::from_value(serde_json::Value::String(text.to_owned())).ok())
}

fn unknown(idx: usize, text: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, format!("unknown value: {text}").into())
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
