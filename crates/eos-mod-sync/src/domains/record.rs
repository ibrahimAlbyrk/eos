//! A domain whose records a feature lists and applies itself, in their
//! portable form ([`RecordSync`]).

use std::sync::Arc;

use eos_contracts::SyncDomainName;
use eos_core::net::sync::{RecordSync, SyncDomain};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::Value;

pub struct RecordDomain {
    name: SyncDomainName,
    records: Arc<dyn RecordSync>,
}

impl std::fmt::Debug for RecordDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordDomain").field("name", &self.name).finish_non_exhaustive()
    }
}

impl RecordDomain {
    pub fn new(name: SyncDomainName, records: Arc<dyn RecordSync>) -> Self {
        Self { name, records }
    }
}

impl SyncDomain for RecordDomain {
    fn name(&self) -> SyncDomainName {
        self.name
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        self.records.list()
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        self.records.get(id)
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        self.records.apply(id, data)
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.records.remove(id)
    }
}
