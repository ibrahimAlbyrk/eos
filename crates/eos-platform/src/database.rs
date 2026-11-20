//! The database's files, which only SQLite opens while the app runs.
//!
//! SQLite's locks on them are POSIX locks, held by the process: when any
//! other handle on one of these files closes in this process, the process
//! loses every lock it holds on that file without SQLite knowing. Another
//! program then believes it is the database's first user and rebuilds the
//! shared-memory index under the app's mapped copy, which crashes the app.
//! So nothing in the process opens them outside SQLite: the file routes and
//! the agents' file tools ask [`DataPaths::is_database_file`] first, and walks
//! from a folder above them skip them through the data folder's `.ignore`.

use std::io;
use std::path::{Path, PathBuf};

use eos_domain::signals::when::inside_folder;

use crate::paths::DataPaths;

/// The database and its companions, as SQLite names them beside `state.db`.
pub const DATABASE_FILES: &[&str] = &["state.db", "state.db-wal", "state.db-shm", "state.db-journal"];

/// The walker's ignore file in the data folder: ripgrep, the agents' Grep
/// and every other walker built on the same rules read it.
const IGNORE_FILE: &str = ".ignore";

/// `path` with its links resolved; as written when it does not exist.
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}

/// `path` names `file` by its text: `.` and `..` resolved, case ignored.
fn same_path(path: &Path, file: &Path) -> bool {
    inside_folder(path, file) && inside_folder(file, path)
}

impl DataPaths {
    /// `path` is one of this data folder's database files, as written or
    /// where its links lead. Relative paths are the caller's to resolve.
    pub fn is_database_file(&self, path: &Path) -> bool {
        let names_one = |path: &Path, home: &Path| DATABASE_FILES.iter().any(|name| same_path(path, &home.join(name)));
        names_one(path, self.home()) || names_one(&real(path), &real(self.home()))
    }

    /// A walk from `root` reaches the database files: `root` is the data
    /// folder or a folder above it, as written or where its links lead.
    pub fn walk_reaches_database(&self, root: &Path) -> bool {
        inside_folder(self.home(), root) || inside_folder(&real(self.home()), &real(root))
    }

    /// Makes the data folder's `.ignore` list the database files, adding
    /// only the lines it lacks: whatever else the file says stays.
    pub fn ignore_database_files(&self) -> io::Result<()> {
        let path = self.home().join(IGNORE_FILE);
        let mut text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e),
        };
        let missing: Vec<String> = DATABASE_FILES
            .iter()
            .map(|name| format!("/{name}"))
            .filter(|line| !text.lines().any(|have| have.trim() == line))
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        for line in missing {
            text.push_str(&line);
            text.push('\n');
        }
        std::fs::write(&path, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_database_files_are_known_however_their_path_is_spelled() {
        let paths = DataPaths::new("/Users/me/.eos");
        for path in [
            "/Users/me/.eos/state.db",
            "/Users/me/.eos/state.db-wal",
            "/Users/me/.eos/state.db-shm",
            "/Users/me/.eos/state.db-journal",
            "/Users/me/.eos/./pages/../state.db-shm",
            "/Users/ME/.EOS/State.DB",
        ] {
            assert!(paths.is_database_file(Path::new(path)), "{path}");
        }
        for path in
            ["/Users/me/.eos", "/Users/me/.eos/pages/state.db", "/Users/me/other/state.db", "/Users/me/.eos/x.db"]
        {
            assert!(!paths.is_database_file(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn a_link_to_a_database_file_is_one() {
        let dir = tempfile::tempdir().expect("dir");
        let home = dir.path().join("data");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::write(home.join("state.db-shm"), "").expect("shm");
        std::os::unix::fs::symlink(home.join("state.db-shm"), dir.path().join("innocent.txt")).expect("link");
        std::os::unix::fs::symlink(&home, dir.path().join("elsewhere")).expect("folder link");
        let paths = DataPaths::new(&home);
        assert!(paths.is_database_file(&dir.path().join("innocent.txt")));
        assert!(paths.is_database_file(&dir.path().join("elsewhere/state.db-shm")));
        assert!(paths.walk_reaches_database(&dir.path().join("elsewhere")));
    }

    #[test]
    fn a_walk_reaches_the_files_from_the_folder_or_above() {
        let paths = DataPaths::new("/Users/me/.eos");
        for root in ["/", "/Users/me", "/Users/me/.eos", "/Users/me/.eos/pages/.."] {
            assert!(paths.walk_reaches_database(Path::new(root)), "{root}");
        }
        for root in ["/Users/me/.eos/pages", "/Users/me/code", "/Users/other"] {
            assert!(!paths.walk_reaches_database(Path::new(root)), "{root}");
        }
    }

    #[test]
    fn the_ignore_file_gains_only_the_lines_it_lacks() {
        let dir = tempfile::tempdir().expect("dir");
        let paths = DataPaths::new(dir.path());
        paths.ignore_database_files().expect("created");
        let lines = "/state.db\n/state.db-wal\n/state.db-shm\n/state.db-journal\n";
        assert_eq!(std::fs::read_to_string(dir.path().join(".ignore")).expect("read"), lines);

        std::fs::write(dir.path().join(".ignore"), "notes/\n/state.db-wal").expect("the user's own");
        paths.ignore_database_files().expect("completed");
        paths.ignore_database_files().expect("again");
        let text = std::fs::read_to_string(dir.path().join(".ignore")).expect("read");
        assert_eq!(text, "notes/\n/state.db-wal\n/state.db\n/state.db-shm\n/state.db-journal\n");
    }
}
