//! `recents.json` (`infra/src/persistence/JsonRecentsRepo.ts`).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use eos_core::store::RecentFolders;
use serde_json::Value;

use crate::json;

const MAX_ENTRIES: usize = 20;

/// Recently used folders: a JSON array of absolute paths, most recent first,
/// each once, at most [`MAX_ENTRIES`].
#[derive(Debug)]
pub struct JsonRecents {
    file: PathBuf,
    paths: Mutex<Vec<String>>,
}

impl JsonRecents {
    pub fn open(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        let paths = match json::read(&file) {
            Some(Value::Array(entries)) => entries
                .into_iter()
                .filter_map(|e| match e {
                    Value::String(path) if !path.is_empty() => Some(path),
                    _ => None,
                })
                .take(MAX_ENTRIES)
                .collect(),
            _ => Vec::new(),
        };
        Self { file, paths: Mutex::new(paths) }
    }

    fn paths(&self) -> MutexGuard<'_, Vec<String>> {
        self.paths.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The list is a convenience: a write that fails is not worth failing its caller for.
    fn save(&self, paths: &[String]) {
        if let Ok(text) = serde_json::to_string(paths) {
            let _ = json::write(&self.file, &text);
        }
    }
}

impl RecentFolders for JsonRecents {
    fn list(&self) -> Vec<String> {
        self.paths().iter().filter(|p| Path::new(p).exists()).cloned().collect()
    }

    fn push(&self, path: &str) {
        let path = path.trim();
        if path.is_empty() {
            return;
        }
        let mut paths = self.paths();
        paths.retain(|p| p != path);
        paths.insert(0, path.to_owned());
        paths.truncate(MAX_ENTRIES);
        self.save(&paths);
    }

    fn remove(&self, path: &str) {
        let mut paths = self.paths();
        if paths.iter().any(|p| p == path) {
            paths.retain(|p| p != path);
            self.save(&paths);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::TempHome;

    // infra/src/persistence/__tests__/JsonRecentsRepo.test.ts
    #[test]
    fn the_newest_folder_comes_first_and_missing_ones_are_hidden() {
        let home = TempHome::new();
        let (a, b) = (home.write("a/.keep", ""), home.write("b/.keep", ""));
        let (a, b) = (a.parent().expect("a").display().to_string(), b.parent().expect("b").display().to_string());
        let store = JsonRecents::open(home.join("recents.json"));
        store.push(&a);
        store.push(&format!("  {b} "));
        store.push(&a);
        store.push("/does/not/exist");
        store.push("  ");
        assert_eq!(store.list(), [a.clone(), b.clone()], "the missing folder is hidden");
        assert_eq!(home.read("recents.json"), format!(r#"["/does/not/exist","{a}","{b}"]"#), "but kept on disk");

        store.remove(&b);
        assert_eq!(JsonRecents::open(home.join("recents.json")).list(), [a]);
    }

    #[test]
    fn the_list_is_capped_and_a_broken_file_reads_empty() {
        let home = TempHome::new();
        let store = JsonRecents::open(home.join("recents.json"));
        for i in 0..25 {
            store.push(&format!("/p{i}"));
        }
        let stored: Vec<String> = serde_json::from_str(&home.read("recents.json")).expect("JSON");
        assert_eq!(stored.len(), MAX_ENTRIES);
        assert_eq!(stored[0], "/p24");

        home.write("recents.json", r#"{"not":"a list"}"#);
        assert!(JsonRecents::open(home.join("recents.json")).list().is_empty());
    }
}
