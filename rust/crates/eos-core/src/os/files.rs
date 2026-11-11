use std::path::{Path, PathBuf};

use crate::{BoxFuture, Error};

/// One child of a folder. A link is followed once to tell whether it points
/// at a folder; a broken link reads as a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntryMeta {
    pub name: String,
    pub absolute_path: PathBuf,
    /// Relative to the listing's root, `/` separated.
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FsStat {
    pub is_dir: bool,
    /// Bytes; what the system reports for a folder.
    pub size: u64,
    /// Milliseconds since the epoch, with the fraction the system keeps.
    pub mtime_ms: f64,
    pub is_symlink: bool,
    /// This process may not write it.
    pub readonly: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListDirOptions<'a> {
    /// What `relative_path` is relative to.
    pub root: &'a Path,
    /// Include names starting with a dot.
    pub include_hidden: bool,
    /// Leave out the ignored names (`node_modules`, `.git`, …).
    pub apply_ignore: bool,
}

/// A file read for the viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRead {
    /// Contains a NUL byte in its first 8 KiB.
    Binary {
        size: u64,
    },
    /// Text, but larger than the caller's limit: not loaded.
    Large {
        size: u64,
    },
    Text {
        content: String,
        lines: u64,
        size: u64,
    },
}

/// An open file, read in pieces. Blocking: call it off the async threads.
pub trait OpenFile: Send {
    fn is_file(&self) -> bool;
    fn size(&self) -> u64;
    /// Milliseconds since the epoch.
    fn mtime_ms(&self) -> f64;
    /// Up to `max` bytes from `offset`; empty at the end.
    fn read_at(&mut self, offset: u64, max: usize) -> Result<Vec<u8>, Error>;
}

/// The user's files: what the Files panel, the viewers and the editor reach.
/// Paths are absolute and already checked by the caller. A missing path is
/// [`Error::NotFound`] (`path not found: <path>`), a collision
/// [`Error::Conflict`] (`already exists: <path>`), a refusal
/// [`Error::PermissionDenied`]; anything else is [`Error::Storage`] carrying
/// the system's message in today's words (`ENOTDIR: not a directory, …`).
///
/// [`read_text`](Self::read_text), [`open`](Self::open),
/// [`write_text`](Self::write_text) and [`write_temp`](Self::write_temp)
/// report every failure as [`Error::Storage`] with that message: their routes
/// answer it verbatim.
pub trait FileSystem: Send + Sync {
    fn list_dir<'a>(
        &'a self,
        dir: &'a Path,
        options: ListDirOptions<'a>,
    ) -> BoxFuture<'a, Result<Vec<FsEntryMeta>, Error>>;
    fn stat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<FsStat, Error>>;
    fn exists<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, bool>;
    /// Reads a file as text unless it is binary or over `max_text_bytes`.
    fn read_text<'a>(&'a self, path: &'a Path, max_text_bytes: u64) -> BoxFuture<'a, Result<FileRead, Error>>;
    fn open<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Box<dyn OpenFile>, Error>>;
    /// Replaces the file's content; `mkdirp` first creates the folders above it.
    fn write_text<'a>(&'a self, path: &'a Path, content: &'a str, mkdirp: bool) -> BoxFuture<'a, Result<(), Error>>;
    /// Writes `bytes` as `<temp>/<prefix><random>/<name>` and returns that path.
    fn write_temp<'a>(
        &'a self,
        prefix: &'a str,
        name: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<PathBuf, Error>>;
    /// Creates a file that must not exist yet.
    fn create_file<'a>(&'a self, path: &'a Path, content: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// Creates one folder; the one above it must exist.
    fn mkdir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>>;
    /// Never replaces an existing `to`.
    fn rename<'a>(&'a self, from: &'a Path, to: &'a Path) -> BoxFuture<'a, Result<(), Error>>;
    /// Moves across folders (and filesystems); replaces `to` only with `overwrite`.
    fn move_entry<'a>(&'a self, from: &'a Path, to: &'a Path, overwrite: bool) -> BoxFuture<'a, Result<(), Error>>;
    /// A delete that can be undone: the system trash, else Eos's own trash folder.
    fn trash<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>>;
}
