use std::path::Path;

use eos_contracts::SymbolOccurrence;

use crate::{BoxFuture, Error};

/// Go to definition, find references and symbol search by name, from the
/// syntax alone: two symbols of one name in different files both match.
/// `root` is the project folder an index is kept for.
pub trait SymbolIndex: Send + Sync {
    /// Builds the index of `root` if it is missing or stale.
    fn ensure_indexed<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Result<(), Error>>;
    /// Definitions of `name`; with `from_path`, those in the same file, then
    /// the same folder, come first.
    fn definitions<'a>(
        &'a self,
        root: &'a Path,
        name: &'a str,
        from_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>>;
    /// Every occurrence of `name`, definitions included.
    fn references<'a>(&'a self, root: &'a Path, name: &'a str) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>>;
    fn search<'a>(
        &'a self,
        root: &'a Path,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>>;
    /// The definitions in one file, without indexing the project.
    fn definitions_in_file<'a>(
        &'a self,
        root: &'a Path,
        path: &'a Path,
    ) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>>;
    /// Files under `root` changed: re-reads them into a resident index.
    fn invalidate<'a>(&'a self, root: &'a Path, changed: &'a [String]) -> BoxFuture<'a, Result<(), Error>>;
    /// The next query rebuilds `root`'s index.
    fn mark_dirty(&self, root: &Path);
    /// Forgets `root`'s index.
    fn release(&self, root: &Path);
    /// The roots that hold an index or are building one.
    fn resident_roots(&self) -> Vec<String>;
}
