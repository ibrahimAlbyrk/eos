//! Tables that hold one JSON document per row: worker definitions made at run
//! time, dream runs and their ledger, transfers, visual answers.
//!
//! A row whose document no longer fits its type is skipped when read: these
//! tables are regenerable, and an old row must not break a list.

use eos_contracts::{
    DreamCandidate, DreamRun, TransferRecord, ViewRecord, ViewState, WorkerDefinition, WorkerDefinitionRecord,
};

use crate::Error;

pub trait WorkerDefinitionRepo {
    /// Saves `definition` for `owner_id`, replacing its definition of the same name.
    fn create(&self, owner_id: &str, definition: &WorkerDefinition, now: i64) -> Result<(), Error>;
    fn list_for(&self, owner_id: &str) -> Result<Vec<WorkerDefinitionRecord>, Error>;
    fn delete_for_owner(&self, owner_id: &str) -> Result<(), Error>;
}

pub trait DreamRepo {
    fn save(&self, run: &DreamRun) -> Result<(), Error>;
    fn get(&self, id: &str) -> Result<Option<DreamRun>, Error>;
    /// Newest first.
    fn list(&self, limit: i64) -> Result<Vec<DreamRun>, Error>;
    /// The last event of a chat a dream has read; 0 before the first.
    fn watermark(&self, worker_id: &str) -> Result<i64, Error>;
    fn set_watermark(&self, worker_id: &str, event_id: i64) -> Result<(), Error>;
    /// The chats the user keeps dreams out of.
    fn excluded(&self) -> Result<Vec<String>, Error>;
    fn set_excluded(&self, worker_id: &str, excluded: bool) -> Result<(), Error>;
    /// The ledger, most recently seen first.
    fn candidates(&self) -> Result<Vec<DreamCandidate>, Error>;
    /// Replaces the whole ledger.
    fn replace_candidates(&self, candidates: &[DreamCandidate]) -> Result<(), Error>;
}

pub trait TransferRepo {
    fn save(&self, transfer: &TransferRecord) -> Result<(), Error>;
    fn get(&self, id: &str) -> Result<Option<TransferRecord>, Error>;
    /// Newest first.
    fn list(&self, limit: i64) -> Result<Vec<TransferRecord>, Error>;
    fn remove(&self, ids: &[String]) -> Result<(), Error>;
}

/// A view's state as last saved by the dashboard.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredViewState {
    pub state: ViewState,
    pub updated_at: i64,
}

pub trait GenuiViewRepo {
    fn save(&self, view: &ViewRecord) -> Result<(), Error>;
    fn get(&self, id: &str) -> Result<Option<ViewRecord>, Error>;
    fn get_state(&self, id: &str) -> Result<Option<StoredViewState>, Error>;
    fn put_state(&self, id: &str, state: &ViewState, at: i64) -> Result<(), Error>;
    /// Removes a worker's views and their states.
    fn remove_by_worker(&self, worker_id: &str) -> Result<(), Error>;
}
