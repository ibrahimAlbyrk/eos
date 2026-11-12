//! File transfer between the user's computers (`manager/modules/transfer`):
//! the Transfer tab and a focused agent's `send_to_machine`. This computer's
//! disk is the local endpoint and what `/transfer/*` serves to a paired
//! computer; a paired one's is reached over its link.
//!
//! | Route | |
//! |---|---|
//! | `GET /transfer/list` | a folder, as the Transfer tab shows it |
//! | `POST /transfer/scan` | everything under the picked paths |
//! | `GET /transfer/read` | a range of a file, refused when it changed since its scan |
//! | `POST /transfer/prepare` | sets up the staging; says what is already there |
//! | `PUT /transfer/write` | appends a chunk at the staged size |
//! | `POST /transfer/commit` | places what was staged, by the user's decisions |
//! | `POST /transfer/abort` | drops the staging |
//! | `POST /transfer/key`, `/transfer/locate` | a folder's project key, and back |
//! | `GET / POST / DELETE /api/transfers` | this computer's transfers: list, start, clear finished |
//! | `POST /api/transfers/destination` | where picked items would land |
//! | `POST /api/transfers/{id}/pause, resume, cancel, decide` | steering one |
//! | `POST /workers/{id}/transfers`, `GET …/{transferId}` | a focused agent's send, and its progress |

mod jobs;
mod peer;
mod routes;
mod run;
mod service;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{TransferChangeEvent, TransferRecord};
use eos_core::net::machines::Machines;
use eos_core::net::transfer::TransferEndpoint;
use eos_core::transfer::AgentTransfers;
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::jobs::JobRegistry;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};

pub use peer::PeerEndpoint;
pub use run::{DEFAULT_OUTAGE_MS, RunDeps, RunEvents, RunInput, run_transfer};
pub use service::{AgentTransferError, TransferService, TransferServiceDeps};

/// A file transfer moved on, or finished ones were cleared: the Transfer tab
/// renders the payload.
pub const TRANSFER_CHANGE: Topic<TransferChangeEvent> = Topic::new("transfer:change");

pub const TRANSFER_JOB_KIND: &str = "transfer";

pub struct TransferModule {
    endpoint: Arc<dyn TransferEndpoint>,
    service: Arc<TransferService>,
    machines: Arc<dyn Machines>,
    bus: Bus,
    jobs: JobRegistry,
    listening: Mutex<Option<Subscription>>,
}

impl std::fmt::Debug for TransferModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferModule").finish_non_exhaustive()
    }
}

impl TransferModule {
    /// `deps.local` is this computer's disk: the engine's local side and what
    /// the endpoint routes serve.
    pub fn new(deps: TransferServiceDeps, jobs: JobRegistry) -> Self {
        let (endpoint, machines, bus) = (deps.local.clone(), deps.machines.clone(), deps.bus.clone());
        Self { endpoint, service: TransferService::new(deps), machines, bus, jobs, listening: Mutex::new(None) }
    }

    pub fn service(&self) -> Arc<TransferService> {
        self.service.clone()
    }

    /// What the `send_to_machine` tool calls.
    pub fn agent_transfers(&self) -> Arc<dyn AgentTransfers> {
        self.service.clone()
    }
}

/// The receiving computer's name, as a job's title shows it.
fn receiver(machines: &dyn Machines, t: &TransferRecord) -> String {
    match &t.to {
        eos_contracts::MachineRef::Local(_) => machines.local_name(),
        eos_contracts::MachineRef::Text(id) => match machines.get(id) {
            Some(host) => host.alias.unwrap_or(host.name),
            None => "another Mac".to_owned(),
        },
    }
}

impl Module for TransferModule {
    fn id(&self) -> &'static str {
        "transfer"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.endpoint, &self.service)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![TRANSFER_CHANGE.decl()]
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![TRANSFER_JOB_KIND]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.service.start().await?;
            // A transfer in progress (or waiting to be resumed) shows in the Jobs list.
            let (jobs, service, machines) = (self.jobs.clone(), self.service.clone(), self.machines.clone());
            let name = move |t: &TransferRecord| receiver(machines.as_ref(), t);
            for transfer in self.service.list().await? {
                let change = TransferChangeEvent { transfer: Some(transfer), removed: None };
                jobs::on_transfer(&jobs, &service, &change, &name);
            }
            let listening = self.bus.on(&TRANSFER_CHANGE, move |event| {
                if let Ok(change) = event.payload_as::<TransferChangeEvent>() {
                    jobs::on_transfer(&jobs, &service, &change, &name);
                }
            });
            *self.listening.lock().unwrap_or_else(PoisonError::into_inner) = Some(listening);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.listening.lock().unwrap_or_else(PoisonError::into_inner).take();
            self.service.stop().await;
        })
    }
}
