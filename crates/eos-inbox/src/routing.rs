//! Where a permission ask shows: a routine run's in Needs you, a chat's on
//! the banner as always.

use eos_core::inbox::{AskRoute, AskRouting};
use eos_core::store::Tx;

/// Sends the asks of a worker that works for a run to Needs you.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunAsks;

impl AskRouting for RunAsks {
    fn route(&self, tx: &dyn Tx, worker_id: &str) -> AskRoute {
        match tx.routine_sessions().run_of(worker_id) {
            Ok(Some(_)) => AskRoute::Inbox,
            Ok(None) => AskRoute::Banner,
            Err(e) => {
                // An ask the user does not hear about would wait for ever.
                tracing::warn!(worker_id, error = %e, "the run of an asking worker could not be read");
                AskRoute::Banner
            }
        }
    }
}
