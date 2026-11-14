//! Sync (Settings › Sync): what the features let
//! follow the user (profile, avatar, memories, pages, prompt templates,
//! worker definitions) goes to every computer holding the same sync key,
//! through an end-to-end encrypted vault on the relay.
//!
//! | Route | |
//! |---|---|
//! | `GET /api/sync` | status: phase, relay host, last sync, error, records per domain |
//! | `GET /api/sync/key` | the sync key (the user's dashboard only); 404 while off |
//! | `POST /api/sync/create` | a new account: this computer's data becomes its first content |
//! | `POST /api/sync/join` | `{key}`: the account's copy wins where both have one |
//! | `POST /api/sync/now` | a pass now (202) |
//! | `POST /api/sync/leave` | stop syncing; the data stays as it is |
//!
//! All of it stays on this computer: the key is the account and never crosses
//! to a paired one. Every data type is written only through its own write
//! path ([`domains`]); the engine is `eos-sync`.

pub mod domains;
mod routes;
mod service;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::SyncStatusResponse;
use eos_core::net::sync::SyncDomain;
use eos_core::{Clock, git::ProjectKeys};
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::jobs::JobRegistry;
use eos_runtime::module::{IsLocal, Module, ModuleError, SyncContribution};
use eos_runtime::router::{BoxFuture, RouteDef};

pub use service::{DeviceName, RelayUrl, SyncService, SyncServiceDeps, Timing};

/// Sync's status changed: Settings › Sync renders the payload.
pub const SYNC_CHANGE: Topic<SyncStatusResponse> = Topic::new("sync:change");

/// The job a pass that outlasts a moment shows as.
pub const SYNC_JOB_KIND: &str = "sync";

/// What the sync feature is built from.
pub struct SyncParts {
    pub service: SyncServiceDeps,
    /// What the other features let follow the user (`Module::sync`).
    pub contributions: Vec<SyncContribution>,
    /// The folders of hand-edited files (templates, worker definitions).
    pub folders: Vec<Arc<dyn SyncDomain>>,
    /// How a project folder travels between computers.
    pub project_keys: Arc<dyn ProjectKeys>,
    pub clock: Arc<dyn Clock>,
    pub bus: Bus,
    pub jobs: JobRegistry,
}

impl std::fmt::Debug for SyncParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncParts").finish_non_exhaustive()
    }
}

/// A feature's change topic, and how to tell its own edits from the ones
/// sync applied.
struct LocalEdits {
    topic: &'static str,
    is_local: Option<IsLocal>,
}

pub struct SyncModule {
    service: Arc<SyncService>,
    bus: Bus,
    edits: Vec<LocalEdits>,
    subscriptions: Mutex<Vec<Subscription>>,
}

impl std::fmt::Debug for SyncModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncModule").finish_non_exhaustive()
    }
}

impl SyncModule {
    /// Fails when a feature contributes a domain this build cannot carry.
    pub fn new(parts: SyncParts) -> Result<Self, eos_core::Error> {
        let SyncParts { service, contributions, folders, project_keys, clock, bus, jobs } = parts;
        let mut all = folders;
        let mut edits = Vec::new();
        for contribution in contributions {
            all.push(domains::from_contribution(&contribution, &project_keys)?);
            if let Some(topic) = contribution.change_topic {
                edits.push(LocalEdits { topic, is_local: contribution.is_local });
            }
        }
        all.sort_by_key(|domain| domains::push_order(domain.name()));
        let service = SyncService::new(service, all, clock, bus.clone(), jobs);
        Ok(Self { service, bus, edits, subscriptions: Mutex::default() })
    }

    pub fn service(&self) -> Arc<SyncService> {
        self.service.clone()
    }
}

impl Module for SyncModule {
    fn id(&self) -> &'static str {
        "sync"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.service)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![SYNC_CHANGE.decl()]
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![SYNC_JOB_KIND]
    }

    /// Sync pushes local edits once a burst settles; what sync itself applied
    /// is not one.
    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let mut subscriptions = self.subscriptions.lock().unwrap_or_else(PoisonError::into_inner);
        for edits in &self.edits {
            let (service, is_local) = (self.service.clone(), edits.is_local.clone());
            subscriptions.push(self.bus.on(edits.topic, move |event| {
                if is_local.as_ref().is_none_or(|is_local| is_local(event)) {
                    service.note_local_change();
                }
            }));
        }
        Box::pin(std::future::ready(Ok(())))
    }

    /// Only the app that owns the data folder syncs: never two writers on one home.
    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        self.service.start();
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.subscriptions.lock().unwrap_or_else(PoisonError::into_inner).clear();
        self.service.stop();
        Box::pin(std::future::ready(()))
    }
}
