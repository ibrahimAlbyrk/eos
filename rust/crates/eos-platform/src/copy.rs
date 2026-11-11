//! Copies that share storage with their source where the filesystem can
//! (APFS clones: instant, no extra space until one side changes) and are
//! plain copies elsewhere.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Copies one file, as a clone when the filesystem supports it. Returns the file's size.
///
/// The standard library already asks macOS for a clone first (`fclonefileat`)
/// and falls back to a byte copy, so no call of our own is needed.
pub fn clone_copy(from: &Path, to: &Path) -> io::Result<u64> {
    fs::copy(from, to)
}

/// Copies a file or a whole folder, cloning each file. Links are copied as
/// links; sockets and other special files are skipped. `keep` is asked for
/// every entry below `from` (not for `from` itself); a folder it refuses is
/// not entered.
pub fn clone_copy_tree(from: &Path, to: &Path, keep: &dyn Fn(&Path) -> bool) -> io::Result<()> {
    // A stack, not recursion: a profile folder can be deep.
    let mut pending: Vec<(PathBuf, PathBuf)> = vec![(from.to_owned(), to.to_owned())];
    while let Some((src, dst)) = pending.pop() {
        let meta = fs::symlink_metadata(&src)?;
        let kind = meta.file_type();
        if kind.is_symlink() {
            copy_link(&src, &dst)?;
        } else if kind.is_dir() {
            fs::create_dir_all(&dst)?;
            for entry in fs::read_dir(&src)? {
                let entry = entry?;
                let child = entry.path();
                if keep(&child) {
                    pending.push((child, dst.join(entry.file_name())));
                }
            }
            fs::set_permissions(&dst, meta.permissions())?;
        } else if kind.is_file() {
            clone_copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    let target = fs::read_link(src)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, dst)
    }
    #[cfg(not(unix))]
    {
        let _ = (target, dst);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tree_is_copied_with_its_links_and_without_what_the_filter_refuses() {
        let dir = tempfile::tempdir().expect("dir");
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("a/b")).expect("dirs");
        fs::create_dir_all(src.join("Cache")).expect("dirs");
        fs::write(src.join("a/b/file.txt"), "deep").expect("write");
        fs::write(src.join("Cache/blob"), "x").expect("write");
        fs::write(src.join("top"), "top").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink("a/b/file.txt", src.join("link")).expect("link");

        let dst = dir.path().join("dst");
        clone_copy_tree(&src, &dst, &|p| p.file_name().is_none_or(|n| n != "Cache")).expect("copy");
        assert_eq!(fs::read_to_string(dst.join("a/b/file.txt")).expect("read"), "deep");
        assert_eq!(fs::read_to_string(dst.join("top")).expect("read"), "top");
        assert!(!dst.join("Cache").exists());
        #[cfg(unix)]
        assert_eq!(fs::read_link(dst.join("link")).expect("link"), Path::new("a/b/file.txt"));
    }

    #[test]
    fn a_single_file_is_copied_and_the_source_stays_independent() {
        let dir = tempfile::tempdir().expect("dir");
        let (src, dst) = (dir.path().join("state.db"), dir.path().join("copy.db"));
        fs::write(&src, vec![7u8; 100_000]).expect("write");
        assert_eq!(clone_copy(&src, &dst).expect("copy"), 100_000);
        fs::write(&src, "changed").expect("rewrite");
        assert_eq!(fs::read(&dst).expect("read"), vec![7u8; 100_000]);
        clone_copy_tree(&src, &dir.path().join("as-tree"), &|_| true).expect("a file is a tree of one");
        assert_eq!(fs::read_to_string(dir.path().join("as-tree")).expect("read"), "changed");
    }
}
