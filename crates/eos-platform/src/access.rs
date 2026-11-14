//! Whether this process may write a path.

use std::path::Path;

/// What `access(path, W_OK)` answers: the path exists and this process may
/// write it. Elsewhere, whether the path is not marked read-only.
pub fn can_write(path: &Path) -> bool {
    #[cfg(unix)]
    {
        rustix::fs::access(path, rustix::fs::Access::WRITE_OK).is_ok()
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path).is_ok_and(|meta| !meta.permissions().readonly())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_file_is_writable_and_a_missing_one_is_not() {
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(can_write(&file));
        assert!(can_write(dir.path()));
        assert!(!can_write(&dir.path().join("missing")));
        let mut perms = std::fs::metadata(&file).expect("meta").permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file, perms).expect("chmod");
        assert!(!can_write(&file));
    }
}
