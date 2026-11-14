use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use eos_core::os::{FileRead, FileSystem, FsEntryMeta, FsStat, ListDirOptions, OpenFile};
use eos_core::{BoxFuture, Error};
use eos_domain::fs_ignore::is_ignored;
use eos_domain::text::locale_compare;
use eos_kit_fs::path::normalize;
use eos_kit_fs::trash_into_dir;
use eos_platform::HostPlatform;

use crate::errors::{classified, node_message, verbatim};

/// Bytes looked at to tell a binary file from text.
const SNIFF_BYTES: usize = 8192;

/// The `FileSystem` port over the real disk.
#[derive(Clone)]
pub struct DiskFileSystem {
    inner: Arc<Inner>,
}

struct Inner {
    host: &'static dyn HostPlatform,
    trash_dir: PathBuf,
}

impl DiskFileSystem {
    /// `host` supplies the system trash; `trash_dir` is where a trashed path goes when the system trash is
    /// unavailable or refuses.
    pub fn new(host: &'static dyn HostPlatform, trash_dir: impl Into<PathBuf>) -> Self {
        Self { inner: Arc::new(Inner { host, trash_dir: trash_dir.into() }) }
    }
}

impl std::fmt::Debug for DiskFileSystem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiskFileSystem").field("trash_dir", &self.inner.trash_dir).finish_non_exhaustive()
    }
}

/// Runs blocking disk work off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|e| Err(Error::Storage(format!("file work did not finish: {e}"))))
}

/// `to` as seen from `from`, by the text of the two paths (Node's `path.relative`).
fn relative(from: &Path, to: &Path) -> String {
    let (from, to) = (normalize(from), normalize(to));
    let from: Vec<Component<'_>> = from.components().collect();
    let to: Vec<Component<'_>> = to.components().collect();
    let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let ups = std::iter::repeat_n("..".to_owned(), from.len() - shared);
    let downs = to[shared..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned());
    ups.chain(downs).collect::<Vec<_>>().join("/")
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    match meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
        Some(since) => since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1_000_000.0,
        None => 0.0,
    }
}

fn list_dir(dir: &Path, root: &Path, include_hidden: bool, apply_ignore: bool) -> Result<Vec<FsEntryMeta>, Error> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(classified("scandir", dir))? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        if (!include_hidden && name.starts_with('.')) || (apply_ignore && is_ignored(&name)) {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let absolute_path = dir.join(&name);
        let is_symlink = kind.is_symlink();
        // A link is followed once to see whether it points at a folder; a broken one reads as a file.
        let is_dir = if is_symlink { fs::metadata(&absolute_path).is_ok_and(|m| m.is_dir()) } else { kind.is_dir() };
        entries.push(FsEntryMeta {
            relative_path: relative(root, &absolute_path),
            name,
            absolute_path,
            is_dir,
            is_symlink,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| locale_compare(&a.name, &b.name)));
    Ok(entries)
}

fn stat(path: &Path) -> Result<FsStat, Error> {
    let link = fs::symlink_metadata(path).map_err(classified("lstat", path))?;
    let is_symlink = link.file_type().is_symlink();
    let (mut is_dir, mut size, mut mtime) = (link.is_dir(), link.len(), mtime_ms(&link));
    if is_symlink {
        match fs::metadata(path) {
            Ok(target) => (is_dir, size, mtime) = (target.is_dir(), target.len(), mtime_ms(&target)),
            Err(_) => is_dir = false,
        }
    }
    Ok(FsStat { is_dir, size, mtime_ms: mtime, is_symlink, readonly: !eos_platform::can_write(path) })
}

fn read_text(path: &Path, max_text_bytes: u64) -> Result<FileRead, Error> {
    let read_failed = |e: io::Error| Error::Storage(node_message(&e, "read", None));
    let mut file = File::open(path).map_err(verbatim("open", path))?;
    // Sniffed and sized before it is read: a binary or oversized file is answered without loading it.
    let mut head = vec![0u8; SNIFF_BYTES];
    let mut sniffed = 0;
    while sniffed < head.len() {
        match file.read(&mut head[sniffed..]).map_err(read_failed)? {
            0 => break,
            n => sniffed += n,
        }
    }
    head.truncate(sniffed);
    let size = file.metadata().map_err(verbatim("fstat", path))?.len();
    if head.contains(&0) {
        return Ok(FileRead::Binary { size });
    }
    if size > max_text_bytes {
        return Ok(FileRead::Large { size });
    }
    let mut bytes = head;
    file.read_to_end(&mut bytes).map_err(read_failed)?;
    let lines = 1 + bytes.iter().filter(|b| **b == b'\n').count() as u64;
    let size = bytes.len() as u64;
    Ok(FileRead::Text { content: String::from_utf8_lossy(&bytes).into_owned(), lines, size })
}

struct Opened {
    file: Option<File>,
    is_file: bool,
    size: u64,
    mtime_ms: f64,
}

impl OpenFile for Opened {
    fn is_file(&self) -> bool {
        self.is_file
    }

    fn size(&self) -> u64 {
        self.size
    }

    fn mtime_ms(&self) -> f64 {
        self.mtime_ms
    }

    fn read_at(&mut self, offset: u64, max: usize) -> Result<Vec<u8>, Error> {
        let read_failed = |e: io::Error| Error::Storage(node_message(&e, "read", None));
        let Some(file) = self.file.as_mut() else {
            return Err(read_failed(io::Error::from(io::ErrorKind::IsADirectory)));
        };
        file.seek(SeekFrom::Start(offset)).map_err(read_failed)?;
        let mut chunk = vec![0u8; max];
        let mut filled = 0;
        while filled < max {
            match file.read(&mut chunk[filled..]).map_err(read_failed)? {
                0 => break,
                n => filled += n,
            }
        }
        chunk.truncate(filled);
        Ok(chunk)
    }
}

fn open(path: &Path) -> Result<Box<dyn OpenFile>, Error> {
    let meta = fs::metadata(path).map_err(verbatim("stat", path))?;
    let is_file = meta.is_file();
    // A folder opens nowhere the same way; reading it is what fails.
    let file = if meta.is_dir() { None } else { Some(File::open(path).map_err(verbatim("open", path))?) };
    Ok(Box::new(Opened { file, is_file, size: meta.len(), mtime_ms: mtime_ms(&meta) }))
}

fn write_text(path: &Path, content: &[u8], mkdirp: bool) -> Result<(), Error> {
    if mkdirp && let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(verbatim("mkdir", parent))?;
    }
    fs::write(path, content).map_err(verbatim("open", path))
}

fn write_temp(prefix: &str, name: &str, bytes: &[u8]) -> Result<PathBuf, Error> {
    let temp = std::env::temp_dir();
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .rand_bytes(6)
        .tempdir_in(&temp)
        .map_err(|e| Error::Storage(node_message(&e, "mkdtemp", Some(&temp.join(format!("{prefix}XXXXXX"))))))?
        .keep();
    let dest = dir.join(name);
    fs::write(&dest, bytes).map_err(verbatim("open", &dest))?;
    Ok(dest)
}

fn create_file(path: &Path, content: &[u8]) -> Result<(), Error> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(classified("open", path))?;
    file.write_all(content).map_err(verbatim("write", path))
}

fn rename(from: &Path, to: &Path) -> Result<(), Error> {
    if to.exists() {
        return Err(Error::Conflict(format!("already exists: {}", to.display())));
    }
    fs::rename(from, to).map_err(classified("rename", from))
}

fn copy_tree(from: &Path, to: &Path, overwrite: bool) -> io::Result<()> {
    let mut pending = vec![(from.to_owned(), to.to_owned())];
    while let Some((src, dst)) = pending.pop() {
        let kind = fs::symlink_metadata(&src)?.file_type();
        if kind.is_dir() {
            fs::create_dir_all(&dst)?;
            for entry in fs::read_dir(&src)? {
                let entry = entry?;
                pending.push((entry.path(), dst.join(entry.file_name())));
            }
        } else if kind.is_file() {
            if dst.exists() && !overwrite {
                continue;
            }
            eos_platform::clone_copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn move_entry(from: &Path, to: &Path, overwrite: bool) -> Result<(), Error> {
    if !overwrite && to.exists() {
        return Err(Error::Conflict(format!("already exists: {}", to.display())));
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        // Another filesystem: copy, then remove the source.
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            copy_tree(from, to, overwrite).map_err(verbatim("cp", from))?;
            let removed =
                if from.is_dir() && !from.is_symlink() { fs::remove_dir_all(from) } else { fs::remove_file(from) };
            removed
                .or_else(|e| if e.kind() == io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
                .map_err(verbatim("rm", from))
        }
        Err(e) => Err(classified("rename", from)(e)),
    }
}

fn trash(inner: &Inner, path: &Path) -> Result<(), Error> {
    // The system trash may refuse (Finder automation denied) or not exist:
    // Eos's own trash folder keeps the delete working and undoable.
    if inner.host.trash(path).is_ok() {
        return Ok(());
    }
    trash_into_dir(path, &inner.trash_dir).map(drop).map_err(|e| match e {
        eos_kit_fs::Error::Io { source, .. } => Error::Storage(node_message(&source, "rename", Some(path))),
        other => Error::storage(other),
    })
}

impl FileSystem for DiskFileSystem {
    fn list_dir<'a>(
        &'a self,
        dir: &'a Path,
        options: ListDirOptions<'a>,
    ) -> BoxFuture<'a, Result<Vec<FsEntryMeta>, Error>> {
        let (dir, root) = (dir.to_owned(), options.root.to_owned());
        Box::pin(blocking(move || list_dir(&dir, &root, options.include_hidden, options.apply_ignore)))
    }

    fn stat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<FsStat, Error>> {
        let path = path.to_owned();
        Box::pin(blocking(move || stat(&path)))
    }

    fn exists<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, bool> {
        let path = path.to_owned();
        Box::pin(async move { blocking(move || Ok(path.exists())).await.unwrap_or(false) })
    }

    fn read_text<'a>(&'a self, path: &'a Path, max_text_bytes: u64) -> BoxFuture<'a, Result<FileRead, Error>> {
        let path = path.to_owned();
        Box::pin(blocking(move || read_text(&path, max_text_bytes)))
    }

    fn open<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Box<dyn OpenFile>, Error>> {
        let path = path.to_owned();
        Box::pin(blocking(move || open(&path)))
    }

    fn write_text<'a>(&'a self, path: &'a Path, content: &'a str, mkdirp: bool) -> BoxFuture<'a, Result<(), Error>> {
        let (path, content) = (path.to_owned(), content.as_bytes().to_vec());
        Box::pin(blocking(move || write_text(&path, &content, mkdirp)))
    }

    fn write_temp<'a>(
        &'a self,
        prefix: &'a str,
        name: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<PathBuf, Error>> {
        let (prefix, name, bytes) = (prefix.to_owned(), name.to_owned(), bytes.to_vec());
        Box::pin(blocking(move || write_temp(&prefix, &name, &bytes)))
    }

    fn create_file<'a>(&'a self, path: &'a Path, content: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let (path, content) = (path.to_owned(), content.as_bytes().to_vec());
        Box::pin(blocking(move || create_file(&path, &content)))
    }

    fn mkdir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        let path = path.to_owned();
        Box::pin(blocking(move || fs::create_dir(&path).map_err(classified("mkdir", &path))))
    }

    fn rename<'a>(&'a self, from: &'a Path, to: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        let (from, to) = (from.to_owned(), to.to_owned());
        Box::pin(blocking(move || rename(&from, &to)))
    }

    fn move_entry<'a>(&'a self, from: &'a Path, to: &'a Path, overwrite: bool) -> BoxFuture<'a, Result<(), Error>> {
        let (from, to) = (from.to_owned(), to.to_owned());
        Box::pin(blocking(move || move_entry(&from, &to, overwrite)))
    }

    fn trash<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        let (inner, path) = (self.inner.clone(), path.to_owned());
        Box::pin(blocking(move || trash(&inner, &path)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_follow_the_text() {
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/b/c/d.txt")), "c/d.txt");
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/b")), "");
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/x/y")), "../x/y");
        assert_eq!(relative(Path::new("/a/b/"), Path::new("/a/b/./c")), "c");
    }
}
