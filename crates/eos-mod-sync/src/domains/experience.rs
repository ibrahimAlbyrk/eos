//! What Eos learned from work (`experience`): memory's notes and each Mac's
//! counters, as memory writes and reads them; two Macs' changes of one note
//! merge, and a pass after the first reads only what changed.

use std::sync::Arc;

use eos_contracts::SyncDomainName;
use eos_core::experience::ExperienceSync;
use eos_core::net::sync::{Changed, SyncDomain};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::Value;

pub struct ExperienceDomain {
    memory: Arc<dyn ExperienceSync>,
}

impl std::fmt::Debug for ExperienceDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExperienceDomain").finish_non_exhaustive()
    }
}

impl ExperienceDomain {
    pub fn new(memory: Arc<dyn ExperienceSync>) -> Self {
        Self { memory }
    }
}

impl SyncDomain for ExperienceDomain {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Experience
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        self.memory.list()
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        self.memory.get(id)
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        self.memory.apply(id, data)
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.memory.remove(id)
    }

    fn merge(&self, local: &Value, remote: &Value) -> Option<Value> {
        self.memory.merge(local, remote)
    }

    fn changed_since(&self, since_ms: f64) -> Option<BoxFuture<'_, Result<Changed, Error>>> {
        Some(self.memory.changed_since(since_ms as i64))
    }
}
