//! A folder of documents, one file each, held in memory.
//!
//! Pages and memories are small files named after their id. The app is their
//! only writer, so each folder is read once and every change is written
//! through: reads never touch the disk, a write replaces one file atomically,
//! a delete moves the file to the folder's `.trash`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::SystemTime;

use indexmap::IndexMap;

use crate::atomic::{WriteOptions, atomic_write};
use crate::error::Error;
use crate::lock::PathLocks;
use crate::trash::move_to_trash;

/// Documents of type `T` stored as `<dir>/<id>.<ext>`, in the order of their
/// file names and then the order documents were added (a rewrite keeps its place).
#[derive(Debug)]
pub struct DocDir<T> {
    dir: PathBuf,
    ext: &'static str,
    locks: PathLocks,
    docs: RwLock<IndexMap<String, Arc<T>>>,
}

impl<T> DocDir<T> {
    /// Reads every `*.<ext>` file of `dir` (a missing folder is empty).
    /// `parse` turns a file's text into its id and document; a file it
    /// refuses, one that is not UTF-8 or one whose id is not its file name is
    /// skipped, so one bad file never hides the rest.
    pub fn load(dir: impl Into<PathBuf>, ext: &'static str, parse: impl Fn(&str) -> Option<(String, T)>) -> Self {
        let dir = dir.into();
        // By name, as Node lists a folder: the order of `list` is on the wire.
        let mut names: Vec<_> = fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.file_name()).collect();
        names.sort();
        let mut docs = IndexMap::new();
        for name in names {
            let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(ext)).and_then(|n| n.strip_suffix('.')) else {
                continue;
            };
            let Ok(raw) = fs::read_to_string(dir.join(&name)) else { continue };
            if let Some((id, doc)) = parse(&raw).filter(|(id, _)| id == stem) {
                docs.insert(id, Arc::new(doc));
            }
        }
        Self { dir, ext, locks: PathLocks::new(), docs: RwLock::new(docs) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn list(&self) -> Vec<Arc<T>> {
        self.docs.read().unwrap_or_else(PoisonError::into_inner).values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<T>> {
        self.docs.read().unwrap_or_else(PoisonError::into_inner).get(id).cloned()
    }

    fn file_of(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.{}", self.ext))
    }

    /// Writes `content` as the file of `id` and keeps `doc` as its document.
    /// `id` becomes a file name: the caller has checked its shape.
    pub fn put(&self, id: &str, doc: T, content: &str) -> Result<Arc<T>, Error> {
        let path = self.file_of(id);
        let _held = self.locks.lock(&path);
        atomic_write(&path, content.as_bytes(), &WriteOptions::default())?;
        let doc = Arc::new(doc);
        self.docs.write().unwrap_or_else(PoisonError::into_inner).insert(id.to_owned(), doc.clone());
        Ok(doc)
    }

    /// Moves the file of `id` to `.trash/<id>.<stamp of now>.<ext>` and
    /// forgets the document. `false` when there is no such document.
    pub fn remove(&self, id: &str, now: SystemTime) -> Result<bool, Error> {
        let path = self.file_of(id);
        let _held = self.locks.lock(&path);
        if self.get(id).is_none() {
            return Ok(false);
        }
        move_to_trash(&self.dir, id, self.ext, now)?;
        self.docs.write().unwrap_or_else(PoisonError::into_inner).shift_remove(id);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    fn parse(raw: &str) -> Option<(String, String)> {
        let (id, text) = raw.split_once('\n')?;
        Some((id.to_owned(), text.to_owned()))
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).expect("list").filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
        names.sort();
        names
    }

    #[test]
    fn loads_what_parses_and_is_named_after_its_id() {
        let dir = tempfile::tempdir().expect("dir");
        fs::write(dir.path().join("a.md"), "a\nfirst").expect("write");
        fs::write(dir.path().join("b.md"), "not-b\nwrong name").expect("write");
        fs::write(dir.path().join("c.md"), "no line feed").expect("write");
        fs::write(dir.path().join("d.txt"), "d\nother type").expect("write");
        fs::write(dir.path().join("e.md"), [0xff, 0xfe]).expect("write");
        fs::create_dir(dir.path().join(".trash")).expect("dir");
        for name in ["z", "K", "m", "10", "9"] {
            fs::write(dir.path().join(format!("{name}.md")), format!("{name}\n{name}")).expect("write");
        }
        let docs = DocDir::load(dir.path(), "md", parse);
        assert_eq!(docs.list().iter().map(|d| d.as_str()).collect::<Vec<_>>(), ["10", "9", "K", "first", "m", "z"]);
        assert_eq!(docs.get("a").as_deref().map(String::as_str), Some("first"));
        assert!(docs.get("b").is_none());

        let none = DocDir::<String>::load(dir.path().join("missing"), "md", parse);
        assert!(none.list().is_empty());
    }

    #[test]
    fn a_write_goes_to_the_file_and_keeps_the_documents_place() {
        let dir = tempfile::tempdir().expect("dir");
        let docs = DocDir::load(dir.path().join("pages"), "md", parse);
        docs.put("a", "one".to_owned(), "a\none").expect("put");
        docs.put("b", "two".to_owned(), "b\ntwo").expect("put");
        docs.put("a", "one again".to_owned(), "a\none again").expect("put");
        assert_eq!(docs.list().iter().map(|d| d.as_str()).collect::<Vec<_>>(), ["one again", "two"]);
        assert_eq!(fs::read_to_string(dir.path().join("pages/a.md")).expect("read"), "a\none again");
        assert_eq!(names(docs.dir()), ["a.md", "b.md"]);

        let again = DocDir::load(dir.path().join("pages"), "md", parse);
        assert_eq!(again.list().len(), 2);
    }

    #[test]
    fn a_delete_moves_the_file_to_the_trash() {
        let dir = tempfile::tempdir().expect("dir");
        let docs = DocDir::load(dir.path(), "md", parse);
        docs.put("a", "one".to_owned(), "a\none").expect("put");
        docs.put("b", "two".to_owned(), "b\ntwo").expect("put");
        docs.put("c", "three".to_owned(), "c\nthree").expect("put");
        let now = UNIX_EPOCH + Duration::from_millis(1_767_259_800_125);
        assert!(docs.remove("a", now).expect("remove"));
        assert!(!docs.remove("a", now).expect("gone already"));
        assert_eq!(docs.list().iter().map(|d| d.as_str()).collect::<Vec<_>>(), ["two", "three"], "order kept");
        assert_eq!(names(dir.path()), [".trash", "b.md", "c.md"]);
        assert_eq!(fs::read_to_string(dir.path().join(".trash/a.2026-01-01T09-30-00-125.md")).expect("read"), "a\none");
    }
}
