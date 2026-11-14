//! Worker definitions over their two homes: files and `state.db`.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::{WorkerDefinition, WorkerDefinitionRecord};
use eos_core::store::{Store, WorkerDefinitionFiles};
use eos_core::{Clock, Error};

use crate::catalog::merge_available;
use crate::definition::records_from;
use crate::resolve::resolve_by_name;

pub struct WorkerDefinitions {
    files: Arc<dyn WorkerDefinitionFiles>,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for WorkerDefinitions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerDefinitions").finish_non_exhaustive()
    }
}

impl WorkerDefinitions {
    pub fn new(files: Arc<dyn WorkerDefinitionFiles>, store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> Self {
        Self { files, store, clock }
    }

    /// The definitions on disk for a session in `cwd`: built-in, the user's,
    /// the project's — a later one of the same name wins. Read fresh.
    pub fn on_disk(&self, cwd: Option<&Path>) -> Vec<WorkerDefinitionRecord> {
        records_from(&self.files.list(cwd))
    }

    /// The definitions `owner` created at runtime. A stored one that is no
    /// longer a valid definition is left out.
    pub async fn runtime(&self, owner: &str) -> Result<Vec<WorkerDefinitionRecord>, Error> {
        let owner = owner.to_owned();
        self.store.read(move |tx| tx.worker_definitions().list_for(&owner)).await
    }

    /// Everything `owner` may spawn from: the definitions on disk for its
    /// folder (its worktree, else its working folder) with its own runtime
    /// ones over them. Without an owner: what is on disk for no folder.
    pub async fn available(&self, owner: Option<&str>) -> Result<Vec<WorkerDefinitionRecord>, Error> {
        let Some(owner) = owner.filter(|owner| !owner.is_empty()) else {
            return Ok(self.on_disk(None));
        };
        let id = owner.to_owned();
        let row = self.store.read(move |tx| tx.workers().find(&id)).await?;
        let cwd = row.and_then(|w| w.worktree_dir.or(w.cwd));
        Ok(merge_available(self.on_disk(cwd.as_deref().map(Path::new)), self.runtime(owner).await?))
    }

    /// Stores a definition `owner` created; one of the same name is replaced.
    pub async fn create(&self, owner: &str, definition: &WorkerDefinition) -> Result<(), Error> {
        let (owner, definition, now) = (owner.to_owned(), definition.clone(), self.clock.now_ms());
        self.store.write(move |tx, _| tx.worker_definitions().create(&owner, &definition, now)).await
    }

    /// The owner's worker row is gone for good: so are its definitions.
    pub async fn forget_owner(&self, owner: &str) -> Result<(), Error> {
        let owner = owner.to_owned();
        self.store.write(move |tx, _| tx.worker_definitions().delete_for_owner(&owner)).await
    }

    /// The definition a spawn named `name` gets: looked up among the files
    /// for `cwd` and then the definitions of `owner` (the orchestrator that
    /// spawns), with `extends` resolved. `None` when nothing has that name.
    pub async fn resolve(
        &self,
        name: &str,
        cwd: Option<&Path>,
        owner: Option<&str>,
    ) -> Result<Option<WorkerDefinition>, Error> {
        let mut records = self.on_disk(cwd);
        if let Some(owner) = owner.filter(|owner| !owner.is_empty()) {
            records.extend(self.runtime(owner).await?);
        }
        Ok(resolve_by_name(name, &records))
    }
}
