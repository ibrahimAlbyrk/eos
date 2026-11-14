//! The user's memories as `<home>/profile/memories/<id>.md`: YAML frontmatter
//! (everything but the text), then the memory's text, so each stays readable
//! and searchable by hand. A deleted memory goes to `.trash/`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use eos_contracts::UserMemory;
use eos_core::store::UserMemoryStore;
use eos_core::{Clock, Error};
use eos_kit_fs::{DocDir, frontmatter};
use serde_json::Value;

pub struct FileUserMemoryStore {
    docs: DocDir<UserMemory>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FileUserMemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileUserMemoryStore").field("dir", &self.docs.dir()).finish_non_exhaustive()
    }
}

impl FileUserMemoryStore {
    /// Reads every memory of `dir`. A file that does not read as a memory is skipped.
    pub fn open(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        let docs = DocDir::load(dir, "md", |raw| parse_user_memory(raw).map(|memory| (memory.id.0.clone(), memory)));
        Self { docs, clock }
    }
}

impl UserMemoryStore for FileUserMemoryStore {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        self.docs.list()
    }

    fn get(&self, id: &str) -> Option<Arc<UserMemory>> {
        self.docs.get(id)
    }

    fn put(&self, memory: UserMemory) -> Result<Arc<UserMemory>, Error> {
        eos_contracts::check(&memory).map_err(|e| Error::Validation(e.message()))?;
        let content = serialize_user_memory(&memory)?;
        let id = memory.id.0.clone();
        self.docs.put(&id, memory, &content).map_err(Error::storage)
    }

    fn remove(&self, id: &str) -> Result<bool, Error> {
        let now = UNIX_EPOCH + Duration::from_millis(u64::try_from(self.clock.now_ms()).unwrap_or(0));
        self.docs.remove(id, now).map_err(Error::storage)
    }
}

/// The file of a memory: its fields but the text as frontmatter, in the
/// memory's field order, then the text and a line feed.
pub fn serialize_user_memory(memory: &UserMemory) -> Result<String, Error> {
    let mut meta = serde_json::to_value(memory).map_err(Error::storage)?;
    if let Value::Object(fields) = &mut meta {
        fields.shift_remove("text");
    }
    frontmatter::join(&meta, &format!("{}\n", memory.text)).map_err(Error::storage)
}

/// Reads a memory file. `None` when it has no frontmatter or is not a memory.
pub fn parse_user_memory(raw: &str) -> Option<UserMemory> {
    let (mut meta, body) = frontmatter::parse::<Value>(raw).ok()??;
    meta.as_object_mut()?.insert("text".to_owned(), Value::String(body.to_owned()));
    eos_contracts::parse(&meta).ok()
}
