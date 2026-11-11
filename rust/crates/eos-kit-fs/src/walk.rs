//! Listing a tree with bounds: a depth, and a number of entries after which
//! the walk stops and says so.

use std::fs;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    /// Never followed: a link to a folder is one entry, not a subtree.
    Link,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkEntry {
    pub path: PathBuf,
    /// Relative to the root, `/` between segments.
    pub relative: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, Copy)]
pub struct WalkOptions<'a> {
    /// Levels of folders read; 1 lists the root only.
    pub max_depth: usize,
    /// Entries visited before the walk gives up.
    pub max_entries: usize,
    /// Skip names starting with a dot.
    pub skip_hidden: bool,
    /// Names skipped wherever they appear (`node_modules`, `.git`…).
    pub ignore: &'a [&'a str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkEnd {
    Complete,
    /// `max_entries` was reached: the listing is partial.
    Truncated,
    /// The visitor stopped it.
    Stopped,
}

/// Visits every entry below `root`: a folder's own entries in byte order of
/// their names, then its subfolders in the same order. A folder that cannot be
/// read is skipped. Memory is bounded by the depth times the size of one folder.
pub fn walk(root: &Path, options: &WalkOptions<'_>, visit: &mut dyn FnMut(&WalkEntry) -> ControlFlow<()>) -> WalkEnd {
    let mut visited = 0usize;
    // (folder, its relative path, levels of folders left below it)
    let mut pending: Vec<(PathBuf, String, usize)> = Vec::new();
    if options.max_depth > 0 {
        pending.push((root.to_owned(), String::new(), options.max_depth - 1));
    }
    while let Some((dir, rel, below)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut children: Vec<(String, EntryKind)> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name().into_string().ok()?;
                if (options.skip_hidden && name.starts_with('.')) || options.ignore.contains(&name.as_str()) {
                    return None;
                }
                let kind = entry.file_type().ok()?;
                let kind = if kind.is_symlink() {
                    EntryKind::Link
                } else if kind.is_dir() {
                    EntryKind::Dir
                } else {
                    EntryKind::File
                };
                Some((name, kind))
            })
            .collect();
        children.sort_unstable_by(|a, b| a.0.cmp(&b.0));

        let mut subdirs = Vec::new();
        for (name, kind) in children {
            if visited >= options.max_entries {
                return WalkEnd::Truncated;
            }
            visited += 1;
            let relative = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let entry = WalkEntry { path: dir.join(&name), relative, kind };
            if visit(&entry).is_break() {
                return WalkEnd::Stopped;
            }
            if kind == EntryKind::Dir && below > 0 {
                subdirs.push((entry.path, entry.relative, below - 1));
            }
        }
        // Reversed, so the stack pops them in name order.
        pending.extend(subdirs.into_iter().rev());
    }
    WalkEnd::Complete
}

/// The relative paths of everything below `root` that is not a folder.
pub fn list_files(root: &Path, options: &WalkOptions<'_>) -> (Vec<String>, WalkEnd) {
    let mut files = Vec::new();
    let end = walk(root, options, &mut |entry| {
        if entry.kind != EntryKind::Dir {
            files.push(entry.relative.clone());
        }
        ControlFlow::Continue(())
    });
    (files, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: WalkOptions<'_> =
        WalkOptions { max_depth: 5, max_entries: 1000, skip_hidden: true, ignore: &["node_modules"] };

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("dir");
        for file in ["a.txt", "src/main.rs", "src/deep/er/x.rs", ".hidden/secret", "node_modules/pkg/index.js", ".env"]
        {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
            fs::write(path, "x").expect("write");
        }
        dir
    }

    #[test]
    fn files_are_listed_relative_without_hidden_and_ignored_names() {
        let dir = tree();
        let (files, end) = list_files(dir.path(), &ALL);
        assert_eq!(files, ["a.txt", "src/main.rs", "src/deep/er/x.rs"]);
        assert_eq!(end, WalkEnd::Complete);

        let everything = WalkOptions { skip_hidden: false, ignore: &[], ..ALL };
        assert_eq!(list_files(dir.path(), &everything).0.len(), 6);
    }

    #[test]
    fn the_depth_bound_stops_the_descent() {
        let dir = tree();
        assert_eq!(list_files(dir.path(), &WalkOptions { max_depth: 1, ..ALL }).0, ["a.txt"]);
        assert_eq!(list_files(dir.path(), &WalkOptions { max_depth: 2, ..ALL }).0, ["a.txt", "src/main.rs"]);
        assert!(list_files(dir.path(), &WalkOptions { max_depth: 0, ..ALL }).0.is_empty());
    }

    #[test]
    fn the_entry_bound_ends_the_walk_and_says_so() {
        let dir = tempfile::tempdir().expect("dir");
        for i in 0..50 {
            fs::write(dir.path().join(format!("f{i:02}")), "x").expect("write");
        }
        let (files, end) = list_files(dir.path(), &WalkOptions { max_entries: 10, ..ALL });
        assert_eq!(files.len(), 10);
        assert_eq!(end, WalkEnd::Truncated);
        assert_eq!(list_files(dir.path(), &WalkOptions { max_entries: 50, ..ALL }).1, WalkEnd::Complete);
    }

    #[test]
    fn the_visitor_can_stop_and_folders_come_before_their_contents() {
        let dir = tree();
        let mut seen = Vec::new();
        let end = walk(dir.path(), &ALL, &mut |entry| {
            seen.push((entry.relative.clone(), entry.kind));
            if entry.relative == "src/deep" { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
        });
        assert_eq!(end, WalkEnd::Stopped);
        assert_eq!(
            seen,
            [
                ("a.txt".to_owned(), EntryKind::File),
                ("src".to_owned(), EntryKind::Dir),
                ("src/deep".to_owned(), EntryKind::Dir)
            ]
        );
    }

    // Through `ln`, so this crate names no system-specific API.
    fn symlink(target: &Path, link: &Path) {
        let made = std::process::Command::new("ln").arg("-s").arg(target).arg(link).status().expect("ln");
        assert!(made.success());
    }

    #[test]
    fn a_link_to_a_folder_is_one_entry_and_is_not_entered() {
        let dir = tree();
        let outside = tree();
        symlink(outside.path(), &dir.path().join("linked"));
        symlink(dir.path(), &dir.path().join("loop"));
        let (files, end) = list_files(dir.path(), &ALL);
        assert_eq!(files, ["a.txt", "linked", "loop", "src/main.rs", "src/deep/er/x.rs"]);
        assert_eq!(end, WalkEnd::Complete);
    }

    #[test]
    fn a_missing_root_is_an_empty_listing() {
        assert_eq!(list_files(Path::new("/no/such/eos/folder"), &ALL), (Vec::new(), WalkEnd::Complete));
    }
}
