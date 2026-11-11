use std::fs;
use std::path::{Path, PathBuf};

use eos_platform::DataPaths;

/// A data folder (`~/.eos` for the code under test) that lives as long as the
/// value and is removed with it.
#[derive(Debug)]
pub struct TempHome {
    dir: tempfile::TempDir,
}

impl TempHome {
    /// An empty data folder.
    pub fn new() -> Self {
        Self { dir: tempfile::Builder::new().prefix("eos-home-").tempdir().expect("a temporary folder") }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn paths(&self) -> DataPaths {
        DataPaths::new(self.dir.path())
    }

    pub fn join(&self, name: impl AsRef<Path>) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Writes `content` to `name` inside the folder, creating the folders above it.
    pub fn write(&self, name: impl AsRef<Path>, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("the parent folder");
        }
        fs::write(&path, content).expect("the file");
        path
    }

    pub fn read(&self, name: impl AsRef<Path>) -> String {
        fs::read_to_string(self.join(name)).expect("the file")
    }
}

impl Default for TempHome {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_goes_away_with_the_value() {
        let home = TempHome::new();
        let file = home.write("pages/a.md", "# A");
        assert_eq!(home.read("pages/a.md"), "# A");
        assert_eq!(home.paths().state_db(), home.join("state.db"));
        let root = home.path().to_owned();
        drop(home);
        assert!(!file.exists() && !root.exists());
    }
}
