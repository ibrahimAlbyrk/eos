//! Memories: everything but this computer's revision; a project scope
//! travels as its repository key and lands in this computer's checkout.

use std::sync::Arc;

use eos_contracts::{SyncDomainName, UserMemory};
use eos_core::git::ProjectKeys;
use eos_core::net::sync::SyncDomain;
use eos_core::profile::UserMemorySync;
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::{Value, json};

use super::project_ref::{to_path, to_ref};
use super::refused;

pub struct MemoryDomain {
    memories: Arc<dyn UserMemorySync>,
    keys: Arc<dyn ProjectKeys>,
}

impl std::fmt::Debug for MemoryDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryDomain").finish_non_exhaustive()
    }
}

impl MemoryDomain {
    pub fn new(memories: Arc<dyn UserMemorySync>, keys: Arc<dyn ProjectKeys>) -> Self {
        Self { memories, keys }
    }

    async fn item(&self, memory: &UserMemory) -> Result<SyncItem, Error> {
        let mut data = serde_json::to_value(memory).map_err(Error::storage)?;
        let Some(fields) = data.as_object_mut() else { return Err(Error::Storage("a memory is an object".into())) };
        fields.shift_remove("id");
        fields.shift_remove("rev");
        // Last, as the TypeScript spreads the rest and then sets the scope.
        let scope = fields.shift_remove("scope").unwrap_or(Value::Null);
        let portable = match scope.get("path").and_then(Value::as_str) {
            Some(path) => json!({ "kind": "project", "project": to_ref(self.keys.as_ref(), path).await }),
            None => scope,
        };
        fields.insert("scope".to_owned(), portable);
        Ok(SyncItem { id: memory.id.0.clone(), data, updated_at: Some(memory.updated_at.as_f64()) })
    }

    async fn apply_now(&self, id: &str, data: &Value) -> Result<(), Error> {
        let mut memory = data.as_object().cloned().ok_or_else(|| refused("a memory is an object"))?;
        let scope = match memory.get("scope") {
            Some(scope) if scope.get("kind").and_then(Value::as_str) == Some("global") => json!({ "kind": "global" }),
            Some(scope) if scope.get("kind").and_then(Value::as_str) == Some("project") => {
                let project = scope.get("project").ok_or_else(|| refused("scope.project: Required"))?;
                json!({ "kind": "project", "path": to_path(self.keys.as_ref(), project).await? })
            }
            _ => return Err(refused("scope: Invalid discriminator value")),
        };
        memory.insert("scope".to_owned(), scope);
        memory.insert("id".to_owned(), Value::String(id.to_owned()));
        // The revision is this computer's own: whatever is sent is not used.
        memory.insert("rev".to_owned(), json!(0));
        let memory: UserMemory = eos_contracts::validate::parse(&Value::Object(memory)).map_err(refused)?;
        self.memories.apply_synced(memory).map(|_| ())
    }
}

impl SyncDomain for MemoryDomain {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Memory
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(async move {
            let memories = self.memories.list();
            let mut items = Vec::with_capacity(memories.len());
            for memory in &memories {
                items.push(self.item(memory).await?);
            }
            Ok(items)
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        Box::pin(async move {
            match self.memories.list().into_iter().find(|memory| memory.id.0 == id) {
                Some(memory) => Ok(Some(self.item(&memory).await?)),
                None => Ok(None),
            }
        })
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.apply_now(id, data))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(self.memories.remove_synced(id)))
    }
}
