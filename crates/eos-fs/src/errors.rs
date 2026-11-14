//! A failed file operation in the words today's wire uses.

use std::io;
use std::path::Path;

use eos_core::Error;

/// The system's name and description of an error, as Node prints them.
fn errno(e: &io::Error) -> Option<(&'static str, &'static str)> {
    use io::ErrorKind as K;
    Some(match e.kind() {
        K::NotFound => ("ENOENT", "no such file or directory"),
        K::PermissionDenied if e.raw_os_error() == Some(1) => ("EPERM", "operation not permitted"),
        K::PermissionDenied => ("EACCES", "permission denied"),
        K::AlreadyExists => ("EEXIST", "file already exists"),
        K::NotADirectory => ("ENOTDIR", "not a directory"),
        K::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        K::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        K::CrossesDevices => ("EXDEV", "cross-device link not permitted"),
        K::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        K::StorageFull => ("ENOSPC", "no space left on device"),
        K::InvalidInput => ("EINVAL", "invalid argument"),
        K::InvalidFilename => ("ENAMETOOLONG", "name too long"),
        K::FileTooLarge => ("EFBIG", "file too large"),
        K::ResourceBusy => ("EBUSY", "resource busy or locked"),
        K::TooManyLinks => ("EMLINK", "too many links"),
        _ => match e.raw_os_error() {
            Some(23) => ("ENFILE", "file table overflow"),
            Some(24) => ("EMFILE", "too many open files"),
            _ => return None,
        },
    })
}

/// `ENOENT: no such file or directory, open '/a/b'`: the text of the error
/// Node raises for a failed `syscall` on `path`, which today's routes answer
/// verbatim. An error with no known name keeps the system's own text.
pub fn node_message(e: &io::Error, syscall: &str, path: Option<&Path>) -> String {
    match (errno(e), path) {
        (Some((code, text)), Some(path)) => format!("{code}: {text}, {syscall} '{}'", path.display()),
        (Some((code, text)), None) => format!("{code}: {text}, {syscall}"),
        (None, _) => e.to_string(),
    }
}

/// Every failure as its message: for the operations whose route answers the
/// text as it is.
pub(crate) fn verbatim<'a>(syscall: &'static str, path: &'a Path) -> impl FnOnce(io::Error) -> Error + 'a {
    move |e| Error::Storage(node_message(&e, syscall, Some(path)))
}

/// A missing path, a collision and a refusal as the errors the wire has a
/// status for; anything else with its message.
pub(crate) fn classified<'a>(syscall: &'static str, path: &'a Path) -> impl FnOnce(io::Error) -> Error + 'a {
    move |e| match e.kind() {
        io::ErrorKind::NotFound => Error::not_found("path", path.display().to_string()),
        io::ErrorKind::AlreadyExists => Error::Conflict(format!("already exists: {}", path.display())),
        io::ErrorKind::PermissionDenied => Error::PermissionDenied(format!("permission denied: {}", path.display())),
        _ => Error::Storage(node_message(&e, syscall, Some(path))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The expected texts are what Node 26 prints for the same failures
    // (recorded in fixtures/wire/recordings/13-files.json).
    #[test]
    fn failures_read_as_node_words_them() {
        let missing = std::fs::File::open("/no/such/eos/file.md").expect_err("missing");
        assert_eq!(
            node_message(&missing, "open", Some(Path::new("/no/such/eos/file.md"))),
            "ENOENT: no such file or directory, open '/no/such/eos/file.md'"
        );
        assert_eq!(
            node_message(&missing, "stat", Some(Path::new("/x/nope.png"))),
            "ENOENT: no such file or directory, stat '/x/nope.png'"
        );
        let dir = tempfile::tempdir().expect("dir");
        let folder = std::fs::read(dir.path()).expect_err("a folder");
        assert_eq!(node_message(&folder, "read", None), "EISDIR: illegal operation on a directory, read");
    }

    #[test]
    fn the_wire_has_a_status_for_missing_existing_and_refused() {
        let path = Path::new("/a/b");
        let kind = |k: io::ErrorKind| classified("open", path)(io::Error::from(k));
        assert_eq!(kind(io::ErrorKind::NotFound).to_string(), "path not found: /a/b");
        assert_eq!(kind(io::ErrorKind::AlreadyExists), Error::Conflict("already exists: /a/b".into()));
        assert_eq!(kind(io::ErrorKind::PermissionDenied), Error::PermissionDenied("permission denied: /a/b".into()));
        assert_eq!(kind(io::ErrorKind::NotADirectory), Error::Storage("ENOTDIR: not a directory, open '/a/b'".into()));
    }
}
