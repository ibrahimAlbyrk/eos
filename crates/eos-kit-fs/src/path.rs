//! Paths that arrive from outside (the dashboard, an agent, a paired
//! computer): is this one safe to use, and does it stay inside that root.
//!
//! Two kinds of check:
//! - lexical ([`normalize`], [`is_inside`]): what the text says, no disk access;
//! - on disk ([`resolve_within_root`], [`real_is_inside`]): links resolved on
//!   both sides, so a link inside the root that points out is caught.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// An absolute path with no NUL byte.
pub fn is_safe_abs_path(path: &str) -> bool {
    !path.contains('\0') && Path::new(path).is_absolute()
}

/// A non-empty relative path with no `..` segment. Either separator counts.
pub fn is_repo_relative(path: &str) -> bool {
    !path.is_empty()
        && !Path::new(path).is_absolute()
        && !path.starts_with('\\')
        && !path.split(['/', '\\']).any(|segment| segment == "..")
}

/// Removes `.` and resolves `..` by the text alone (no disk access), the way
/// Node's `path.resolve` does for an absolute path: `..` at the root stays at the root.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let at_root = matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_)));
                let is_up = matches!(out.components().next_back(), Some(Component::ParentDir) | None);
                if is_up {
                    out.push("..");
                } else if !at_root {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `child` is `parent` itself or below it, by the text of the normalized paths.
pub fn is_inside(parent: &Path, child: &Path) -> bool {
    normalize(child).strip_prefix(normalize(parent)).is_ok()
}

/// The real path of the deepest ancestor of `abs` that exists, with the rest
/// re-appended — so a path that is yet to be created can still be checked.
fn realpath_nearest(abs: &Path) -> PathBuf {
    let mut current = abs.to_owned();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = fs::canonicalize(&current) {
            return tail.iter().rev().fold(real, |path, part| path.join(part));
        }
        match (current.parent().map(Path::to_owned), current.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_owned());
                current = parent;
            }
            // Reached the top without resolving anything.
            _ => return abs.to_owned(),
        }
    }
}

/// The real absolute path of `target` (relative to `root`, or absolute) if it
/// stays inside `root`, else `None`. Links are resolved on both sides. The
/// target may not exist yet; the root must.
pub fn resolve_within_root(root: &Path, target: &str) -> Option<PathBuf> {
    if target.contains('\0') || root.as_os_str().as_encoded_bytes().contains(&0) {
        return None;
    }
    let real_root = fs::canonicalize(root).ok()?;
    let real = realpath_nearest(&normalize(&real_root.join(target)));
    real.strip_prefix(&real_root).is_ok().then_some(real)
}

/// Both exist and, with links resolved, `dir` is `root` or below it.
pub fn real_is_inside(root: &Path, dir: &Path) -> bool {
    match (fs::canonicalize(root), fs::canonicalize(dir)) {
        (Ok(root), Ok(dir)) => dir.strip_prefix(root).is_ok(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("dir");
        let real = fs::canonicalize(dir.path()).expect("real");
        (dir, real)
    }

    #[test]
    fn dots_are_resolved_by_the_text() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), Path::new("/a/c"));
        assert_eq!(normalize(Path::new("/a/b/../../../x")), Path::new("/x"));
        assert_eq!(normalize(Path::new("/h/x/../peer/pair")), Path::new("/h/peer/pair"));
        assert_eq!(normalize(Path::new("a/../../b")), Path::new("../b"));
        assert_eq!(normalize(Path::new("/")), Path::new("/"));
    }

    #[test]
    fn inside_means_the_same_folder_or_below_it() {
        assert!(is_inside(Path::new("/a/b"), Path::new("/a/b")));
        assert!(is_inside(Path::new("/a/b"), Path::new("/a/b/c/d")));
        assert!(is_inside(Path::new("/a/b"), Path::new("/a/b/c/../d")));
        assert!(!is_inside(Path::new("/a/b"), Path::new("/a/bc")), "a sibling with the same prefix");
        assert!(!is_inside(Path::new("/a/b"), Path::new("/a/b/../c")));
        assert!(!is_inside(Path::new("/a/b"), Path::new("/a")));
        assert!(is_inside(Path::new("/a/b"), Path::new("/a/b/..c")), "a name that merely starts with dots");
    }

    #[test]
    fn safe_absolute_and_repo_relative_paths() {
        assert!(is_safe_abs_path("/Users/me/project"));
        assert!(!is_safe_abs_path("relative/path"));
        assert!(!is_safe_abs_path("/a\0b"));
        assert!(!is_safe_abs_path(""));

        assert!(is_repo_relative("src/main.rs"));
        assert!(is_repo_relative("a..b/c"));
        assert!(!is_repo_relative(""));
        assert!(!is_repo_relative("/etc/passwd"));
        assert!(!is_repo_relative("../outside"));
        assert!(!is_repo_relative("src/../../x"));
        assert!(!is_repo_relative("src\\..\\x"));
    }

    #[test]
    fn a_path_inside_the_root_resolves_to_its_real_path() {
        let (_dir, root) = tmp();
        fs::create_dir(root.join("src")).expect("dir");
        fs::write(root.join("src/a.txt"), "x").expect("write");
        assert_eq!(resolve_within_root(&root, "src/a.txt"), Some(root.join("src/a.txt")));
        assert_eq!(resolve_within_root(&root, "."), Some(root.clone()));
        let absolute = root.join("src/a.txt");
        assert_eq!(resolve_within_root(&root, absolute.to_str().expect("utf-8")), Some(absolute));
    }

    #[test]
    fn dot_dot_and_absolute_escapes_are_refused() {
        let (_dir, root) = tmp();
        fs::create_dir(root.join("src")).expect("dir");
        assert_eq!(resolve_within_root(&root, "../outside"), None);
        assert_eq!(resolve_within_root(&root, "src/../../escape"), None);
        assert_eq!(resolve_within_root(&root, "/etc/passwd"), None);
        assert_eq!(resolve_within_root(&root, "a\0b"), None);
        assert_eq!(resolve_within_root(&root.join("no-such-root"), "x"), None);
    }

    // Through `ln`, so this crate names no system-specific API.
    fn symlink(target: &Path, link: &Path) {
        let made = std::process::Command::new("ln").arg("-s").arg(target).arg(link).status().expect("ln");
        assert!(made.success());
    }

    #[test]
    fn a_link_that_leaves_the_root_is_refused() {
        let (_dir, root) = tmp();
        let (_out, outside) = tmp();
        symlink(&outside, &root.join("escape"));
        assert_eq!(resolve_within_root(&root, "escape"), None);
        assert_eq!(resolve_within_root(&root, "escape/secret.txt"), None);
        assert!(!real_is_inside(&root, &root.join("escape")));

        fs::create_dir(root.join("real")).expect("dir");
        symlink(&root.join("real"), &root.join("alias"));
        assert_eq!(resolve_within_root(&root, "alias/new.txt"), Some(root.join("real/new.txt")));
        assert!(real_is_inside(&root, &root.join("alias")));
    }

    #[test]
    fn a_path_that_does_not_exist_yet_can_be_inside() {
        let (_dir, root) = tmp();
        fs::create_dir(root.join("src")).expect("dir");
        assert_eq!(resolve_within_root(&root, "src/new-file.txt"), Some(root.join("src/new-file.txt")));
        assert_eq!(resolve_within_root(&root, "new/deeper/file.txt"), Some(root.join("new/deeper/file.txt")));
        assert!(!real_is_inside(&root, &root.join("missing")), "a folder that is not there is not inside");
    }
}
