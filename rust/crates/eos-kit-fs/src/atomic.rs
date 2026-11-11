//! A crash-safe write: a temp file beside the target, flushed, then renamed
//! over it.

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::Error;

#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    /// Permissions of the new file, set before any content is written (keys
    /// and tokens: the platform's private-file permissions). `None` leaves the
    /// system default for new files.
    pub permissions: Option<Permissions>,
    /// Also flush the folder, so the rename itself survives a power loss.
    pub durable: bool,
}

impl WriteOptions {
    pub fn with_permissions(permissions: Option<Permissions>) -> Self {
        Self { permissions, durable: false }
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A name no other writer uses: this process, this call, this instant.
fn temp_path(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut temp = std::ffi::OsString::from(".");
    temp.push(name);
    temp.push(format!(".{}-{n}-{nanos:08x}.tmp", std::process::id()));
    dir.join(temp)
}

fn create_temp(dir: &Path, name: &std::ffi::OsStr) -> io::Result<(File, PathBuf)> {
    loop {
        let path = temp_path(dir, name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
}

/// Writes `data` to `path` so that a reader sees the old content or the new,
/// never a mix, and a crash leaves one of the two. Missing parent folders are
/// created. The temp file lives in the target's folder (a rename across
/// filesystems is not atomic) under a unique name, so two writers of one path
/// cannot corrupt each other: the last rename wins.
pub fn atomic_write(path: &Path, data: &[u8], options: &WriteOptions) -> Result<(), Error> {
    let fail = |source| Error::Io { path: path.to_owned(), source };
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(fail(io::Error::new(io::ErrorKind::InvalidInput, "not a file path")));
    };
    let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
    fs::create_dir_all(dir).map_err(fail)?;

    let (mut file, temp) = create_temp(dir, name).map_err(fail)?;
    let written = (|| {
        if let Some(permissions) = &options.permissions {
            file.set_permissions(permissions.clone())?;
        }
        file.write_all(data)?;
        file.sync_data()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(fail(e));
    }
    if options.durable {
        // Not every system lets a folder be opened and flushed; the file itself is safe either way.
        let _ = File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::*;

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).expect("list").filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
        names.sort();
        names
    }

    #[test]
    fn writes_replaces_and_creates_missing_folders_leaving_no_temp_file() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("a/b/page.md");
        atomic_write(&path, b"one", &WriteOptions::default()).expect("write");
        assert_eq!(fs::read(&path).expect("read"), b"one");
        atomic_write(&path, b"two, longer", &WriteOptions { durable: true, ..WriteOptions::default() })
            .expect("replace");
        assert_eq!(fs::read(&path).expect("read"), b"two, longer");
        assert_eq!(entries(path.parent().expect("parent")), ["page.md"]);
    }

    #[test]
    fn the_new_file_gets_the_permissions_asked_for() {
        let dir = tempfile::tempdir().expect("dir");
        let (open, private) = (dir.path().join("open.json"), dir.path().join("identity.json"));
        atomic_write(&open, b"{}", &WriteOptions::default()).expect("write");
        // Any permissions value will do for the test: take a read-only one.
        let mut read_only = fs::metadata(&open).expect("meta").permissions();
        read_only.set_readonly(true);
        atomic_write(&private, b"{}", &WriteOptions::with_permissions(Some(read_only))).expect("write");
        assert!(fs::metadata(&private).expect("meta").permissions().readonly());
        assert!(!fs::metadata(&open).expect("meta").permissions().readonly());
    }

    #[test]
    fn a_failed_write_leaves_the_old_file_and_no_temp_file() {
        let dir = tempfile::tempdir().expect("dir");
        // The target is a non-empty folder: the rename over it fails.
        let target = dir.path().join("taken");
        fs::create_dir(&target).expect("dir");
        fs::write(target.join("keep"), "x").expect("write");
        let err = atomic_write(&target, b"data", &WriteOptions::default()).expect_err("fails");
        assert!(matches!(err, Error::Io { .. }));
        assert_eq!(entries(dir.path()), ["taken"]);
        assert!(target.join("keep").exists());
    }

    #[test]
    fn concurrent_writers_of_one_path_leave_one_whole_file() {
        let dir = tempfile::tempdir().expect("dir");
        let path = Arc::new(dir.path().join("state.json"));
        let writers: Vec<_> = (0..8u8)
            .map(|n| {
                let path = path.clone();
                thread::spawn(move || {
                    let data = vec![b'a' + n; 64 * 1024];
                    for _ in 0..5 {
                        atomic_write(&path, &data, &WriteOptions::default()).expect("write");
                    }
                })
            })
            .collect();
        let reader = {
            let path = path.clone();
            thread::spawn(move || {
                for _ in 0..200 {
                    if let Ok(seen) = fs::read(&*path) {
                        assert_eq!(seen.len(), 64 * 1024);
                        assert!(seen.iter().all(|b| *b == seen[0]), "a reader saw a mix of two writes");
                    }
                }
            })
        };
        for w in writers {
            w.join().expect("writer");
        }
        reader.join().expect("reader");
        assert_eq!(entries(dir.path()), ["state.json"]);
    }
}
