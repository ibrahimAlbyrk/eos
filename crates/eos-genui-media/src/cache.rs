//! The disk cache for visual-answer media: `<dir>/<sha256>.{json,bin}`, in the
//! 0.1.x app's format.
//! Regenerable, not user data. Entries expire after a time; the cache as a
//! whole is held under a byte cap by evicting the least recently used first.
//! Last use is the meta file's modification time (touched on every hit), so
//! the order survives a restart without an index file.
//!
//! Everything here blocks on the disk: call it from a blocking thread.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, UNIX_EPOCH};

use bytes::Bytes;
use eos_core::Clock;
use eos_kit_fs::{WriteOptions, atomic_write};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MAX_BYTES: u64 = 500 * 1024 * 1024;
pub(crate) const TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// A failure is remembered briefly, so a broken image is not fetched again on every render.
pub(crate) const MISS_TTL_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    /// Bytes.
    Blob,
    /// A resolved URL (a page's preview image, a site's icon).
    Ref,
    /// A failure, kept briefly.
    Miss,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Meta {
    pub(crate) url: String,
    pub(crate) kind: Kind,
    pub(crate) content_type: String,
    pub(crate) size: u64,
    pub(crate) fetched_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

impl Meta {
    pub(crate) fn blob(url: &str, content_type: &str, fetched_at: i64) -> Self {
        Self::new(url, Kind::Blob, content_type, fetched_at)
    }

    pub(crate) fn reference(url: &str, to: &str, fetched_at: i64) -> Self {
        Self { r#ref: Some(to.to_owned()), ..Self::new(url, Kind::Ref, "", fetched_at) }
    }

    pub(crate) fn miss(url: &str, reason: &str, fetched_at: i64) -> Self {
        Self { reason: Some(reason.to_owned()), ..Self::new(url, Kind::Miss, "", fetched_at) }
    }

    fn new(url: &str, kind: Kind, content_type: &str, fetched_at: i64) -> Self {
        Self {
            url: url.to_owned(),
            kind,
            content_type: content_type.to_owned(),
            size: 0,
            fetched_at,
            r#ref: None,
            reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hit {
    pub(crate) meta: Meta,
    /// The bytes of a [`Kind::Blob`].
    pub(crate) body: Option<Bytes>,
}

/// `sha256(namespace + "\n" + url)` in hex: an entry's file name.
pub(crate) fn cache_key(namespace: &str, url: &str) -> String {
    let digest = Sha256::new().chain_update(namespace).chain_update("\n").chain_update(url).finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    size: u64,
    last_used: i64,
}

#[derive(Debug, Default)]
struct Index {
    entries: HashMap<String, Entry>,
    total: u64,
    scanned: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) max_bytes: u64,
    pub(crate) ttl_ms: i64,
    pub(crate) miss_ttl_ms: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_bytes: MAX_BYTES, ttl_ms: TTL_MS, miss_ttl_ms: MISS_TTL_MS }
    }
}

pub(crate) struct MediaCache {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    limits: Limits,
    index: Mutex<Index>,
}

impl std::fmt::Debug for MediaCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaCache").field("dir", &self.dir).field("limits", &self.limits).finish_non_exhaustive()
    }
}

fn modified_ms(path: &Path) -> Option<(u64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let at = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((meta.len(), i64::try_from(at.as_millis()).unwrap_or(i64::MAX)))
}

impl MediaCache {
    pub(crate) fn new(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>, limits: Limits) -> Self {
        Self { dir: dir.into(), clock, limits, index: Mutex::default() }
    }

    fn meta_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    fn blob_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.bin"))
    }

    /// The index, read from the folder at first use: sizes and last use come
    /// from the files.
    fn index(&self) -> MutexGuard<'_, Index> {
        let mut index = self.index.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !index.scanned {
            index.scanned = true;
            self.scan(&mut index);
        }
        index
    }

    fn scan(&self, index: &mut Index) {
        let Ok(names) = fs::read_dir(&self.dir) else { return };
        let mut sizes: HashMap<String, u64> = HashMap::new();
        for name in names.flatten().filter_map(|entry| entry.file_name().into_string().ok()) {
            let path = self.dir.join(&name);
            if name.ends_with(".tmp") {
                // What an interrupted write left behind.
                let _ = fs::remove_file(path);
                continue;
            }
            let Some((key, ext)) =
                name.split_once('.').filter(|(key, ext)| is_key(key) && matches!(*ext, "json" | "bin"))
            else {
                continue;
            };
            // A file that vanished since the listing is simply not there.
            let Some((size, modified)) = modified_ms(&path) else { continue };
            *sizes.entry(key.to_owned()).or_default() += size;
            if ext == "json" {
                index.entries.insert(key.to_owned(), Entry { size: 0, last_used: modified });
            }
        }
        for (key, entry) in &mut index.entries {
            entry.size = sizes.get(key).copied().unwrap_or(0);
            index.total += entry.size;
        }
        // Bytes without their meta are an interrupted write.
        for key in sizes.keys().filter(|key| !index.entries.contains_key(*key)) {
            let _ = fs::remove_file(self.blob_path(key));
        }
        self.evict(index);
    }

    fn drop_entry(&self, index: &mut Index, key: &str) {
        if let Some(entry) = index.entries.remove(key) {
            index.total -= entry.size;
        }
        let _ = fs::remove_file(self.meta_path(key));
        let _ = fs::remove_file(self.blob_path(key));
    }

    fn evict(&self, index: &mut Index) {
        if index.total <= self.limits.max_bytes {
            return;
        }
        let mut order: Vec<(String, i64)> = index.entries.iter().map(|(key, e)| (key.clone(), e.last_used)).collect();
        order.sort_by_key(|(_, last_used)| *last_used);
        for (key, _) in order {
            if index.total <= self.limits.max_bytes {
                break;
            }
            self.drop_entry(index, &key);
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<Hit> {
        let mut index = self.index();
        if !is_key(key) || !index.entries.contains_key(key) {
            return None;
        }
        let meta = fs::read(self.meta_path(key)).ok().and_then(|json| serde_json::from_slice::<Meta>(&json).ok());
        let Some(meta) = meta else {
            self.drop_entry(&mut index, key);
            return None;
        };
        let now = self.clock.now_ms();
        let ttl = if meta.kind == Kind::Miss { self.limits.miss_ttl_ms } else { self.limits.ttl_ms };
        if now - meta.fetched_at > ttl {
            self.drop_entry(&mut index, key);
            return None;
        }
        let body = if meta.kind == Kind::Blob {
            match fs::read(self.blob_path(key)) {
                Ok(bytes) => Some(Bytes::from(bytes)),
                Err(_) => {
                    self.drop_entry(&mut index, key);
                    return None;
                }
            }
        } else {
            None
        };
        if let Some(entry) = index.entries.get_mut(key) {
            entry.last_used = now;
        }
        // Best effort: an entry whose time cannot be set only ages a little early.
        let at = UNIX_EPOCH + Duration::from_millis(u64::try_from(now).unwrap_or(0));
        let _ = fs::File::options().write(true).open(self.meta_path(key)).and_then(|file| file.set_modified(at));
        Some(Hit { meta, body })
    }

    /// Stores an entry; one larger than the whole cap is not stored at all.
    pub(crate) fn put(&self, key: &str, meta: &Meta, body: Option<&[u8]>) -> Result<(), eos_kit_fs::Error> {
        if !is_key(key) {
            return Ok(());
        }
        let mut index = self.index();
        let body_len = body.map_or(0, |body| body.len() as u64);
        let meta_json = serde_json::to_vec(&Meta { size: body_len, ..meta.clone() }).unwrap_or_default();
        let size = body_len + meta_json.len() as u64;
        if size > self.limits.max_bytes {
            return Ok(());
        }
        match body {
            Some(body) => atomic_write(&self.blob_path(key), body, &WriteOptions::default())?,
            None => {
                let _ = fs::remove_file(self.blob_path(key));
            }
        }
        atomic_write(&self.meta_path(key), &meta_json, &WriteOptions::default())?;
        if let Some(previous) = index.entries.insert(key.to_owned(), Entry { size, last_used: self.clock.now_ms() }) {
            index.total -= previous.size;
        }
        index.total += size;
        self.evict(&mut index);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn total_bytes(&self) -> u64 {
        self.index().total
    }
}

#[cfg(test)]
mod tests {
    use eos_testkit::{FakeClock, TempHome};

    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

    fn cache(home: &TempHome, clock: &Arc<FakeClock>, limits: Limits) -> MediaCache {
        MediaCache::new(home.path(), clock.clone(), limits)
    }

    fn files_of(home: &TempHome, key: &str) -> usize {
        let names = fs::read_dir(home.path()).expect("the folder").flatten();
        names.filter(|entry| entry.file_name().to_string_lossy().starts_with(key)).count()
    }

    #[test]
    fn a_blob_round_trips_and_expires_after_its_time() {
        let (home, clock) = (TempHome::new(), Arc::new(FakeClock::new()));
        let cache = cache(&home, &clock, Limits { ttl_ms: 1000, ..Limits::default() });
        let key = cache_key("img", "https://a.example/x.png");
        cache
            .put(&key, &Meta::blob("https://a.example/x.png", "image/png", clock.now_ms()), Some(PNG))
            .expect("stored");
        let hit = cache.get(&key).expect("a hit");
        assert_eq!((hit.body.as_deref(), hit.meta.content_type.as_str(), hit.meta.size), (Some(PNG), "image/png", 12));
        clock.advance(1001);
        assert_eq!(cache.get(&key), None);
        assert_eq!(cache.total_bytes(), 0);
        assert_eq!(files_of(&home, &key), 0);
    }

    #[test]
    fn a_miss_is_forgotten_sooner_than_a_hit() {
        let (home, clock) = (TempHome::new(), Arc::new(FakeClock::new()));
        let cache = cache(&home, &clock, Limits { ttl_ms: 10_000, miss_ttl_ms: 100, ..Limits::default() });
        let key = cache_key("img", "u");
        cache.put(&key, &Meta::miss("u", "the server answered 404", clock.now_ms()), None).expect("stored");
        assert_eq!(cache.get(&key).map(|hit| hit.meta.kind), Some(Kind::Miss));
        clock.advance(101);
        assert_eq!(cache.get(&key), None);
    }

    #[test]
    fn the_least_recently_used_goes_first_past_the_byte_cap() {
        let (home, clock) = (TempHome::new(), Arc::new(FakeClock::new()));
        let cache = cache(&home, &clock, Limits { max_bytes: 2500, ..Limits::default() });
        let body = [1u8; 1000];
        let [a, b, c] = ["a", "b", "c"].map(|name| cache_key("img", name));
        cache.put(&a, &Meta::blob("a", "image/png", clock.now_ms()), Some(&body)).expect("stored");
        clock.advance(10);
        cache.put(&b, &Meta::blob("b", "image/png", clock.now_ms()), Some(&body)).expect("stored");
        clock.advance(10);
        assert!(cache.get(&a).is_some(), "a is now fresher than b");
        clock.advance(10);
        cache.put(&c, &Meta::blob("c", "image/png", clock.now_ms()), Some(&body)).expect("stored");
        assert!(cache.get(&a).is_some());
        assert_eq!(cache.get(&b), None);
        assert!(cache.get(&c).is_some());
        assert!(cache.total_bytes() <= 2500);
        assert_eq!(files_of(&home, &b), 0);
        // One entry larger than the whole cap is not stored at all.
        let d = cache_key("img", "d");
        cache.put(&d, &Meta::blob("d", "image/png", clock.now_ms()), Some(&[0u8; 3000])).expect("skipped");
        assert_eq!(cache.get(&d), None);
    }

    #[test]
    fn the_index_is_rebuilt_from_disk_and_half_written_files_go() {
        let (home, clock) = (TempHome::new(), Arc::new(FakeClock::new()));
        let key = cache_key("img", "persist");
        let first = cache(&home, &clock, Limits::default());
        first.put(&key, &Meta::blob("persist", "image/png", clock.now_ms()), Some(PNG)).expect("stored");
        // What a crash leaves: a temp file, bytes without their meta, a stranger's file.
        let orphan = cache_key("img", "orphan");
        home.write(format!(".{key}.bin.123-0-00000000.tmp"), b"half");
        home.write(format!("{orphan}.bin"), b"bytes without meta");
        home.write("notes.txt", b"not ours");

        let again = cache(&home, &clock, Limits::default());
        assert_eq!(again.get(&key).and_then(|hit| hit.body).as_deref(), Some(PNG));
        assert!(again.total_bytes() >= PNG.len() as u64);
        assert_eq!(files_of(&home, &orphan), 0);
        assert!(!home.join(format!(".{key}.bin.123-0-00000000.tmp")).exists());
        assert!(home.join("notes.txt").exists(), "a file that is not the cache's stays");
        // A damaged meta file drops its entry instead of failing the read.
        home.write(format!("{key}.json"), b"{nope");
        let damaged = cache(&home, &clock, Limits::default());
        assert_eq!(damaged.get(&key), None);
        assert_eq!(files_of(&home, &key), 0);
    }

    #[test]
    fn the_meta_file_keeps_todays_format() {
        // `metaFiles` of fixtures/genui-media/vectors.json.
        let blob = Meta { size: 11, ..Meta::blob("https://example.com/a.png", "image/png", 1_700_000_000_000) };
        assert_eq!(
            serde_json::to_string(&blob).expect("json"),
            r#"{"url":"https://example.com/a.png","kind":"blob","contentType":"image/png","size":11,"fetchedAt":1700000000000}"#
        );
        let reference = Meta::reference("example.com", "https://example.com/favicon.ico", 5);
        assert_eq!(
            serde_json::to_string(&reference).expect("json"),
            r#"{"url":"example.com","kind":"ref","contentType":"","size":0,"fetchedAt":5,"ref":"https://example.com/favicon.ico"}"#
        );
        let miss = Meta::miss("https://example.com/x", "the server answered 404", 9);
        assert_eq!(
            serde_json::to_string(&miss).expect("json"),
            r#"{"url":"https://example.com/x","kind":"miss","contentType":"","size":0,"fetchedAt":9,"reason":"the server answered 404"}"#
        );
    }
}
