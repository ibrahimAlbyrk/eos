//! The trash of the files port, and nothing else of it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use eos_core::os::{FileRead, FileSystem, FsEntryMeta, FsStat, ListDirOptions, OpenFile};
use eos_core::{BoxFuture, Error};

/// `FileSystem::trash` into a folder the test gives, listing what it took,
/// `write_temp` into a folder beside it, and `list_dir` of a real folder's
/// direct entries by name; every other method fails, as a store that only
/// trashes never calls them.
#[derive(Debug)]
pub struct FakeTrash {
    dir: PathBuf,
    trashed: Mutex<Vec<PathBuf>>,
    written: Mutex<usize>,
    refused: Mutex<Vec<PathBuf>>,
}

impl FakeTrash {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), trashed: Mutex::default(), written: Mutex::default(), refused: Mutex::default() }
    }

    /// From now on, trashing `path` fails as a full or locked disk would.
    pub fn refuse(&self, path: impl Into<PathBuf>) {
        self.refused.lock().unwrap_or_else(|p| p.into_inner()).push(path.into());
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
    fn list_dir<'a>(&'a self, dir: &'a Path, _: ListDirOptions<'a>) -> BoxFuture<'a, Result<Vec<FsEntryMeta>, Error>> {
        Box::pin(async move {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(dir).map_err(Error::storage)? {
                let entry = entry.map_err(Error::storage)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
                let (absolute_path, relative_path) = (entry.path(), name.clone());
                entries.push(FsEntryMeta { name, absolute_path, relative_path, is_dir, is_symlink: false });
            }
            Ok(entries)
        })
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
            if self.refused.lock().unwrap_or_else(|p| p.into_inner()).iter().any(|r| r == path) {
                return Err(Error::Storage(format!("{}: refused", path.display())));
            }
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
