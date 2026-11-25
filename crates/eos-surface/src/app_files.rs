//! Which files an App may reach (05 Q7): a path the App names is relative
//! to its root, with no `..`, no `~`, no backslash and nothing absolute,
//! and it matches one of its manifest's globs. No part of it is a hidden
//! name: `.git/hooks`, `.claude/settings.json`, `.envrc` and their kind run
//! code outside any sandbox the next time the user works in the project. A glob's `*` stands for any
//! run of characters inside one folder name, `**` for any number of
//! folders. That a link inside the root points out of it is the file
//! store's to refuse, since only the disk can tell.

use crate::app::FileScope;

/// One file an App reads or writes.
pub const APP_FILE_BYTES: usize = 1024 * 1024;
/// The files one `files.list` answers with.
pub const APP_FILES_LISTED: usize = 1000;

/// `path` as the App's root holds it, or why it is no such path.
pub fn app_path(path: &str) -> Result<&str, &'static str> {
    if path.is_empty() || path.len() > 1024 {
        return Err("a path is 1 to 1024 characters");
    }
    if path.starts_with('/') || path.starts_with('~') || path.contains(['\\', '\0']) {
        return Err("a path is relative to the App's root");
    }
    if path.split('/').any(|part| part.is_empty() || part.starts_with('.')) {
        return Err("a path names no `.` or `..`, no hidden name and no empty folder");
    }
    Ok(path)
}

/// Whether `name` matches one folder name of a glob, `*` any run.
fn part_matches(glob: &str, name: &str) -> bool {
    let Some((first, rest)) = glob.split_once('*') else { return glob == name };
    let Some(mut left) = name.strip_prefix(first) else { return false };
    let pieces: Vec<&str> = rest.split('*').collect();
    let (last, middle) = pieces.split_last().map_or(("", &[][..]), |(last, middle)| (*last, middle));
    for piece in middle {
        match left.find(piece) {
            Some(at) => left = &left[at + piece.len()..],
            None => return false,
        }
    }
    left.len() >= last.len() && left.ends_with(last)
}

fn parts_match(glob: &[&str], path: &[&str]) -> bool {
    match glob.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| parts_match(rest, &path[skip..])),
        Some((part, rest)) => {
            path.split_first().is_some_and(|(name, left)| part_matches(part, name) && parts_match(rest, left))
        }
    }
}

/// Whether the relative `path` matches `glob`.
pub fn glob_matches(glob: &str, path: &str) -> bool {
    let glob: Vec<&str> = glob.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    parts_match(&glob, &path)
}

impl FileScope {
    /// A file the App may list and read: one its read or its write globs match.
    pub fn may_read(&self, path: &str) -> bool {
        self.read.iter().chain(&self.write).any(|glob| glob_matches(glob, path))
    }

    pub fn may_write(&self, path: &str) -> bool {
        self.write.iter().any(|glob| glob_matches(glob, path))
    }
}
