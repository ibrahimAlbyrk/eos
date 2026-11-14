//! A small persistent key → value cache with an expiry per entry, kept in one
//! JSON file (geocoder and place-search answers,
//! in the 0.1.x app's file format). Bounded by entry
//! count: the oldest written go first. Writes are coalesced and atomic; a
//! damaged or missing file starts empty.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::Clock;
use eos_kit_fs::{WriteOptions, atomic_write};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    v: Value,
    exp: i64,
}

#[derive(Default)]
struct State {
    /// `None` until first use.
    entries: Option<IndexMap<String, Entry>>,
    dirty: bool,
    /// A writer is at work (or about to check for more).
    writing: bool,
    writer: Option<JoinHandle<()>>,
}

struct Inner {
    file: PathBuf,
    clock: Arc<dyn Clock>,
    max_entries: usize,
    state: Mutex<State>,
}

#[derive(Clone)]
pub(crate) struct JsonTtlStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for JsonTtlStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonTtlStore").field("file", &self.inner.file).finish_non_exhaustive()
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The file's entries that have not expired; empty for a first use or a damaged file.
    fn load(&self) -> IndexMap<String, Entry> {
        let now = self.clock.now_ms();
        let stored = std::fs::read(&self.file)
            .ok()
            .and_then(|json| serde_json::from_slice::<IndexMap<String, Value>>(&json).ok());
        let mut entries = IndexMap::new();
        for (key, raw) in stored.unwrap_or_default() {
            if let Ok(entry) = serde_json::from_value::<Entry>(raw)
                && entry.exp > now
            {
                entries.insert(key, entry);
            }
        }
        entries
    }
}

impl JsonTtlStore {
    pub(crate) fn new(file: impl Into<PathBuf>, clock: Arc<dyn Clock>, max_entries: usize) -> Self {
        Self { inner: Arc::new(Inner { file: file.into(), clock, max_entries, state: Mutex::default() }) }
    }

    /// Reads the file at first use. Blocks on the disk once.
    fn with<T>(&self, change: impl FnOnce(&mut IndexMap<String, Entry>) -> (T, bool)) -> T {
        let mut state = self.inner.state();
        let (out, changed) = change(state.entries.get_or_insert_with(|| self.inner.load()));
        if changed {
            self.schedule(&mut state);
        }
        out
    }

    pub(crate) fn get(&self, key: &str) -> Option<Value> {
        let now = self.inner.clock.now_ms();
        self.with(|entries| match entries.get(key) {
            None => (None, false),
            Some(entry) if entry.exp <= now => {
                entries.shift_remove(key);
                (None, true)
            }
            Some(entry) => (Some(entry.v.clone()), false),
        })
    }

    pub(crate) fn set(&self, key: &str, value: Value, ttl_ms: i64) {
        let exp = self.inner.clock.now_ms() + ttl_ms;
        let max = self.inner.max_entries;
        self.with(|entries| {
            entries.shift_remove(key);
            entries.insert(key.to_owned(), Entry { v: value, exp });
            while entries.len() > max {
                entries.shift_remove_index(0);
            }
            ((), true)
        });
    }

    /// One writer at a time; changes made while it writes are written by the
    /// same writer in one more pass. A cache that cannot persist still
    /// answers from memory.
    fn schedule(&self, state: &mut State) {
        state.dirty = true;
        if state.writing {
            return;
        }
        state.writing = true;
        let inner = self.inner.clone();
        state.writer = Some(tokio::task::spawn_blocking(move || {
            loop {
                let json = {
                    let mut state = inner.state();
                    if !state.dirty {
                        state.writing = false;
                        break;
                    }
                    state.dirty = false;
                    serde_json::to_vec(state.entries.as_ref().unwrap_or(&IndexMap::new())).unwrap_or_default()
                };
                if let Err(e) = atomic_write(&inner.file, &json, &WriteOptions::default()) {
                    tracing::debug!(error = %e, "geo cache: not written");
                }
            }
        }));
    }

    /// Resolves once everything set so far is on disk.
    pub(crate) async fn flush(&self) {
        loop {
            let writer = self.inner.state().writer.take();
            match writer {
                Some(writer) => {
                    let _ = writer.await;
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use eos_testkit::{FakeClock, TempHome};
    use serde_json::json;

    use super::*;

    // "expires entries, caps the count, and persists".
    #[tokio::test(flavor = "multi_thread")]
    async fn entries_expire_the_count_is_capped_and_the_file_persists() {
        let (home, clock) = (TempHome::new(), Arc::new(FakeClock::new()));
        let file = home.join("geo").join("s.json");
        let store = JsonTtlStore::new(&file, clock.clone(), 2);
        store.set("a", json!(1), 100);
        store.set("b", json!(2), 1000);
        store.set("c", json!(3), 1000);
        assert_eq!(store.get("a"), None, "oldest dropped past the cap");
        assert_eq!(store.get("b"), Some(json!(2)));
        store.flush().await;

        let again = JsonTtlStore::new(&file, clock.clone(), 2000);
        assert_eq!(again.get("c"), Some(json!(3)));
        clock.advance(1001);
        assert_eq!(again.get("c"), None);
        // Today's file format: `{ key: { v, exp } }`.
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("the file")).expect("json");
        assert_eq!(on_disk["c"]["v"], 3);
        assert!(on_disk["c"]["exp"].is_i64());
        again.flush().await;
        let rewritten: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("the file")).expect("json");
        assert!(rewritten.get("c").is_none(), "an entry found expired leaves the file");
        assert_eq!(rewritten["b"]["v"], 2, "one nobody asked for stays until it is");

        std::fs::write(&file, b"{nope").expect("written");
        assert_eq!(JsonTtlStore::new(&file, clock, 2).get("b"), None, "a damaged file starts empty");
    }
}
