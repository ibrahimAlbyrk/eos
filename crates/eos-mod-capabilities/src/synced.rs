//! The domain `capability`: the service's definitions as sync's records.

use std::sync::Arc;

use eos_capabilities::CapabilityService;
use eos_core::net::sync::RecordSync;
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::Value;

pub(crate) struct Definitions(pub(crate) Arc<CapabilityService>);

impl RecordSync for Definitions {
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(self.0.synced_list())
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        Box::pin(self.0.synced_get(id))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.0.synced_apply(id, data))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.0.synced_remove(id))
    }
}
