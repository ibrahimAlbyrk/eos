//! What the transfer feature offers the agent tools: sending files of this
//! computer to a paired one (`send_to_machine`).

use eos_contracts::TransferRecord;

use crate::BoxFuture;
use crate::agent::Refused;

/// Transfers a focused session starts. Each call answers what the worker's
/// transfer routes answer the same agent.
pub trait AgentTransfers: Send + Sync + 'static {
    /// Starts sending `paths` (absolute, or relative to the session's folder)
    /// to the paired computer the user calls `machine`: into its
    /// `~/Downloads/Eos`, never replacing a file.
    fn start<'a>(
        &'a self,
        worker_id: &'a str,
        machine: &'a str,
        paths: Vec<String>,
    ) -> BoxFuture<'a, Result<TransferRecord, Refused>>;

    /// The transfer as it stands.
    fn get<'a>(&'a self, worker_id: &'a str, transfer_id: &'a str) -> BoxFuture<'a, Result<TransferRecord, Refused>>;
}
