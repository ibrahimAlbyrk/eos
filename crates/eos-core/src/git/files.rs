use std::path::Path;
use std::sync::Arc;

use crate::BoxFuture;

/// The files of a project that file search and the symbol index consider:
/// tracked files, then untracked ones that are not ignored; a bounded walk
/// where there is no repository. Paths are relative to `root`, `/` separated.
pub trait CandidateFiles: Send + Sync {
    fn list<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Arc<[String]>>;
}
