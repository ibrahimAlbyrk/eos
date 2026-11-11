use std::path::Path;

use eos_contracts::{ChangedFile, FileDiffResponse};

use crate::BoxFuture;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DiffStat {
    pub insertions: u32,
    pub deletions: u32,
    pub files: u32,
}

/// What changed in a working tree or a commit. With a `base`, a comparison
/// covers what was committed since `base` as well as what is uncommitted;
/// without, only what is uncommitted (against HEAD).
pub trait GitDiffs: Send + Sync {
    fn diff_short_stat<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, DiffStat>;
    fn changed_files<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, Vec<ChangedFile>>;
    fn file_diff<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        old_path: Option<&'a str>,
        base: Option<&'a str>,
    ) -> BoxFuture<'a, FileDiffResponse>;
    /// The whole tree as one patch, or `None` when it is unavailable (not a
    /// repository, or larger than the cap): callers then ask file by file.
    fn full_diff<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, Option<String>>;
    /// One commit's whole patch; `None` as for [`full_diff`](Self::full_diff).
    fn commit_patch<'a>(&'a self, cwd: &'a Path, sha: &'a str) -> BoxFuture<'a, Option<String>>;
    fn commit_file_diff<'a>(
        &'a self,
        cwd: &'a Path,
        sha: &'a str,
        path: &'a str,
        old_path: Option<&'a str>,
    ) -> BoxFuture<'a, FileDiffResponse>;
    /// Size in bytes of `rev:path`, to check a cap before reading it.
    fn blob_size_at_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str, path: &'a str) -> BoxFuture<'a, Option<u64>>;
    fn blob_at_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str, path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>>;
    /// A conflicted file as it is on disk, with git's markers. Empty when unreadable.
    fn conflict_file_content<'a>(&'a self, cwd: &'a Path, path: &'a str) -> BoxFuture<'a, String>;
    /// One side of a conflict: stage 1 is the base, 2 ours, 3 theirs. `None`
    /// when that side has no such file.
    fn stage_content<'a>(&'a self, cwd: &'a Path, path: &'a str, stage: u8) -> BoxFuture<'a, Option<String>>;
}
