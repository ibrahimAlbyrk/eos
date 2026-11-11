use std::path::Path;

use eos_contracts::ConflictKind;

use super::{CommandFailed, OpResult};
use crate::BoxFuture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// Writing down a conflict's resolution. What to write is decided elsewhere.
pub trait ConflictResolution: Send + Sync {
    /// Writes the resolved content of a file and stages it.
    fn write_resolved<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), CommandFailed>>;
    /// Resolves an add/delete conflict by keeping or removing the file as
    /// `side` had it, and stages that.
    fn take_side<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        side: ConflictSide,
        kind: ConflictKind,
    ) -> BoxFuture<'a, Result<(), CommandFailed>>;
}

/// Discarding changes in a working tree.
pub trait WorkingTreeRestore: Send + Sync {
    /// Puts `paths` back as they are at `base` (HEAD when `None`), index and
    /// working tree. A path that does not exist at `base` is removed.
    fn restore_to_base<'a>(
        &'a self,
        cwd: &'a Path,
        paths: &'a [String],
        base: Option<&'a str>,
    ) -> BoxFuture<'a, OpResult>;
    /// Removes files git does not track.
    fn remove_untracked<'a>(&'a self, cwd: &'a Path, paths: &'a [String]) -> BoxFuture<'a, OpResult>;
}
