//! Pages on disk (`core/src/ports/PageStore.ts`): markdown notes the user and
//! agents share, one file each under `<home>/pages`.

use std::sync::Arc;

use eos_contracts::Page;

use crate::Error;

/// Every page, held in memory; the files are written through. Reads never
/// touch the disk.
pub trait PageStore: Send + Sync + 'static {
    /// In the order of the file names, then the order pages were added.
    fn list(&self) -> Vec<Arc<Page>>;
    fn get(&self, id: &str) -> Option<Arc<Page>>;
    /// Writes the whole page. [`Error::Validation`] when it breaks a rule of
    /// the stored form (a title or body over its limit).
    fn put(&self, page: Page) -> Result<Arc<Page>, Error>;
    /// Moves the file to the folder's trash. `false` when there is no such page.
    fn remove(&self, id: &str) -> Result<bool, Error>;
}
