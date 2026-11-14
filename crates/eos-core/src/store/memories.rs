//! The user's memories on disk: one file each under `<home>/profile/memories`.

use std::sync::Arc;

use eos_contracts::UserMemory;

use crate::Error;

/// Every memory, tombstones included, held in memory; the files are written
/// through. Reads never touch the disk.
pub trait UserMemoryStore: Send + Sync + 'static {
    /// In the order of the file names, then the order memories were added.
    fn list(&self) -> Vec<Arc<UserMemory>>;
    fn get(&self, id: &str) -> Option<Arc<UserMemory>>;
    /// Writes the whole memory. [`Error::Validation`] when it breaks a rule
    /// of the stored form.
    fn put(&self, memory: UserMemory) -> Result<Arc<UserMemory>, Error>;
    /// Moves the file to the folder's trash. `false` when there is no such memory.
    fn remove(&self, id: &str) -> Result<bool, Error>;
}
