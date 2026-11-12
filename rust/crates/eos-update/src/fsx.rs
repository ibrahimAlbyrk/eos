//! The few file-system facts the update code needs that differ by system:
//! permission bits, links, which volume a folder is on.

use std::fs::{self, Metadata};
use std::io;
use std::path::Path;

/// The permission bits of a file or folder (`mode & 0o777`); 0 where the
/// system has none.
pub(crate) fn mode_of(meta: &Metadata) -> i64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        i64::from(meta.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0
    }
}

pub(crate) fn set_mode(path: &Path, mode: i64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(u32::try_from(mode & 0o777).unwrap_or(0o644)))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

pub(crate) fn symlink(target: &str, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(not(unix))]
    {
        let _ = (target, link);
        Err(io::Error::new(io::ErrorKind::Unsupported, "links are not supported on this system"))
    }
}

/// Both paths are on one volume, so a clone copy and a rename between them work.
pub(crate) fn same_volume(a: &Path, b: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(fs::metadata(a)?.dev() == fs::metadata(b)?.dev())
    }
    #[cfg(not(unix))]
    {
        let (a, b) = (fs::canonicalize(a)?, fs::canonicalize(b)?);
        Ok(a.components().next() == b.components().next())
    }
}

/// Removes a file or a whole folder; one that is not there is not an error.
pub(crate) fn remove_all(path: &Path) -> io::Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) => Err(e),
    };
    match removed {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Writes `bytes` beside `path` and renames it into place, so a reader sees
/// the old file or the whole new one.
pub(crate) fn write_then_rename(path: &Path, suffix: &str, bytes: &[u8]) -> io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(suffix);
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}
