//! The files an App reaches below its root ([`eos_core::surface::AppFiles`]).
//!
//! Every path is resolved with its links against the root's real path, so
//! neither `..` nor a link inside the root reaches a file outside it. A
//! listing never follows a link and never names one.

use std::path::{Path, PathBuf};

use eos_core::surface::AppFiles;
use eos_core::{BoxFuture, Error};
use eos_kit_fs::path::resolve_within_root;
use eos_kit_fs::{EntryKind, WalkOptions, WriteOptions, atomic_write, walk};

/// How deep a listing goes into the root's folders.
const LIST_DEPTH: usize = 12;
/// Entries a listing visits before it stops.
const LIST_VISITS: usize = 20_000;

#[derive(Debug, Clone, Copy, Default)]
pub struct FsAppFiles;

fn outside() -> Error {
    Error::Validation("that file is outside the App's folder".into())
}

fn within(root: &Path, path: &str) -> Result<PathBuf, Error> {
    resolve_within_root(root, path).ok_or_else(outside)
}

fn list(root: &Path, max: usize) -> Vec<String> {
    let options = WalkOptions { max_depth: LIST_DEPTH, max_entries: LIST_VISITS, skip_hidden: true, ignore: &[] };
    let mut files = Vec::new();
    walk(root, &options, &mut |entry| {
        if entry.kind == EntryKind::File {
            files.push(entry.relative.clone());
        }
        if files.len() >= max { std::ops::ControlFlow::Break(()) } else { std::ops::ControlFlow::Continue(()) }
    });
    files
}

fn read(root: &Path, path: &str, max_bytes: usize) -> Result<Option<Vec<u8>>, Error> {
    if !root.is_dir() {
        return Ok(None);
    }
    let file = within(root, path)?;
    let meta = match std::fs::metadata(&file) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::storage("an App's file could not be read")),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > max_bytes as u64 {
        return Err(Error::Validation(format!("that file is more than {max_bytes} bytes")));
    }
    std::fs::read(&file).map(Some).map_err(|_| Error::storage("an App's file could not be read"))
}

fn write(root: &Path, path: &str, body: &[u8]) -> Result<(), Error> {
    // The routine's own files folder is made with its first file.
    std::fs::create_dir_all(root).map_err(|_| Error::storage("an App's folder could not be made"))?;
    let file = within(root, path)?;
    if file.is_dir() {
        return Err(Error::Validation("that path is a folder".into()));
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|_| Error::storage("an App's folder could not be made"))?;
    }
    // The folders just made could only be below the root, but a link put in
    // their place meanwhile would not be: resolve again before writing.
    let file = within(root, path)?;
    // The error names the path, which is the user's: it stays out of the answer and the log.
    atomic_write(&file, body, &WriteOptions::default())
        .map_err(|_| Error::storage("an App's file could not be written"))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(work).await.map_err(|e| Error::storage(e.to_string()))?
}

impl AppFiles for FsAppFiles {
    fn list<'a>(&'a self, root: &'a Path, max: usize) -> BoxFuture<'a, Result<Vec<String>, Error>> {
        let root = root.to_owned();
        Box::pin(blocking(move || Ok(list(&root, max))))
    }

    fn read<'a>(
        &'a self,
        root: &'a Path,
        path: &'a str,
        max_bytes: usize,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, Error>> {
        let (root, path) = (root.to_owned(), path.to_owned());
        Box::pin(blocking(move || read(&root, &path, max_bytes)))
    }

    fn write<'a>(&'a self, root: &'a Path, path: &'a str, body: Vec<u8>) -> BoxFuture<'a, Result<(), Error>> {
        let (root, path) = (root.to_owned(), path.to_owned());
        Box::pin(blocking(move || write(&root, &path, &body)))
    }
}
