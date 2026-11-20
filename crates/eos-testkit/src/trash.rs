//! The trash of the files port, and nothing else of it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use eos_core::os::{FileRead, FileSystem, FsEntryMeta, FsStat, ListDirOptions, OpenFile};
use eos_core::{BoxFuture, Error};

/// `FileSystem::trash` into a folder the test gives, listing what it took,
/// and `write_temp` into a folder beside it; every other method fails, as a
/// store that only trashes never calls them.
#[derive(Debug)]
pub struct FakeTrash {
    dir: PathBuf,
    trashed: Mutex<Vec<PathBuf>>,
    written: Mutex<usize>,
}

impl FakeTrash {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), trashed: Mutex::default(), written: Mutex::default() }
    }

    /// The paths trashed, in order.
    pub fn trashed(&self) -> Vec<PathBuf> {
        self.trashed.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Where the `n`th path trashed (from 0) went.
    pub fn kept(&self, n: usize) -> PathBuf {
        self.dir.join(n.to_string())
    }
}

fn unused<'a, T: Send + 'a>() -> BoxFuture<'a, Result<T, Error>> {
    Box::pin(async { Err(Error::Storage("FakeTrash only trashes".to_owned())) })
}

impl FileSystem for FakeTrash {
    fn list_dir<'a>(&'a self, _: &'a Path, _: ListDirOptions<'a>) -> BoxFuture<'a, Result<Vec<FsEntryMeta>, Error>> {
        unused()
    }

    fn stat<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<FsStat, Error>> {
        unused()
    }

    fn exists<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, bool> {
        Box::pin(async move { path.exists() })
    }

    fn read_text<'a>(&'a self, _: &'a Path, _: u64) -> BoxFuture<'a, Result<FileRead, Error>> {
        unused()
    }

    fn open<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<Box<dyn OpenFile>, Error>> {
        unused()
    }

    fn write_text<'a>(&'a self, _: &'a Path, _: &'a str, _: bool) -> BoxFuture<'a, Result<(), Error>> {
        unused()
    }

    fn write_temp<'a>(
        &'a self,
        prefix: &'a str,
        name: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<PathBuf, Error>> {
        Box::pin(async move {
            let mut written = self.written.lock().unwrap_or_else(|p| p.into_inner());
            *written += 1;
            let dir = self.dir.with_extension("temp").join(format!("{prefix}{written}"));
            std::fs::create_dir_all(&dir).map_err(Error::storage)?;
            let path = dir.join(name);
            std::fs::write(&path, bytes).map_err(Error::storage)?;
            Ok(path)
        })
    }

    fn create_file<'a>(&'a self, _: &'a Path, _: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        unused()
    }

    fn mkdir<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        unused()
    }

    fn rename<'a>(&'a self, _: &'a Path, _: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        unused()
    }

    fn move_entry<'a>(&'a self, _: &'a Path, _: &'a Path, _: bool) -> BoxFuture<'a, Result<(), Error>> {
        unused()
    }

    fn trash<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let mut trashed = self.trashed.lock().unwrap_or_else(|p| p.into_inner());
            let to = self.kept(trashed.len());
            std::fs::create_dir_all(&self.dir).map_err(Error::storage)?;
            std::fs::rename(path, &to).map_err(|e| Error::Storage(format!("{}: {e}", path.display())))?;
            trashed.push(path.to_owned());
            Ok(())
        })
    }

    fn canonical<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<PathBuf, Error>> {
        unused()
    }
}
