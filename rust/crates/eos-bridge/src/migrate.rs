//! One-time carry-over of the Electron app's `localStorage` to the new origin.
//!
//! The old shell kept the dashboard's settings, drafts and layout under the origin
//! `eos://app`; the new origin starts empty. On the first launch the shell reads the old
//! profile's store, hands the keys to the bridge script, which writes them before any
//! dashboard code runs and reports back; a marker file then stops any further read.
//!
//! Chromium's layout (`Local Storage/leveldb`): `_<origin>\0<key>` → value, where key and
//! value start with one encoding byte (0 = UTF-16LE, 1 = Latin-1); `META:<origin>` rows hold
//! bookkeeping. Plain bytewise comparator, snappy blocks.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusty_leveldb::{DB, LdbIterator, Options};

use crate::Error;

/// The origin the Electron shell served the dashboard from.
pub const ELECTRON_ORIGIN: &str = "eos://app";
/// The key the bridge script sets in the new origin once the keys are written.
pub const PAGE_MARKER_KEY: &str = "eos:migratedFromElectron";
const MARKER_FILE: &str = "migrated-from-electron.json";

/// One stored string: the encoding byte, then the text.
pub fn decode(bytes: &[u8]) -> Option<String> {
    match bytes.split_first()? {
        (0, rest) if rest.len() % 2 == 0 => {
            let units: Vec<u16> = rest.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
            String::from_utf16(&units).ok()
        }
        (1, rest) => Some(rest.iter().map(|b| *b as char).collect()),
        _ => None,
    }
}

/// The inverse of [`decode`], choosing the encoding Chromium would.
pub fn encode(text: &str) -> Vec<u8> {
    if text.chars().all(|c| (c as u32) < 256) {
        let mut out = vec![1u8];
        out.extend(text.chars().map(|c| c as u8));
        out
    } else {
        let mut out = vec![0u8];
        out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        out
    }
}

/// The rows of `origin` in an opened store.
fn rows(db: &mut DB, origin: &str) -> Result<(BTreeMap<String, String>, usize), Error> {
    let prefix = format!("_{origin}\0").into_bytes();
    let mut out = BTreeMap::new();
    let mut undecodable = 0;
    let mut it = db.new_iter().map_err(|e| Error::Migration(e.to_string()))?;
    while let Some((key, value)) = it.next() {
        let Some(raw_key) = key.strip_prefix(prefix.as_slice()) else { continue };
        match (decode(raw_key), decode(&value)) {
            (Some(k), Some(v)) => {
                out.insert(k, v);
            }
            _ => undecodable += 1,
        }
    }
    Ok((out, undecodable))
}

/// What was read from the old profile.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Seed {
    pub keys: BTreeMap<String, String>,
    /// Rows whose key or value was in no known encoding; left behind.
    pub undecodable: usize,
}

/// Reads the keys of `origin` from a `Local Storage/leveldb` folder. The folder itself is
/// never opened: a running app holds its lock and opening a store rewrites its manifest, so
/// the files are copied to `scratch` first and the copy is read.
pub fn read_local_storage(leveldb: &Path, origin: &str, scratch: &Path) -> Result<Seed, Error> {
    let copy = scratch.join("leveldb-copy");
    let _ = std::fs::remove_dir_all(&copy);
    std::fs::create_dir_all(&copy).map_err(|e| Error::Migration(format!("{}: {e}", copy.display())))?;
    let entries = std::fs::read_dir(leveldb).map_err(|e| Error::Migration(format!("{}: {e}", leveldb.display())))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        // The lock belongs to whoever has the original open.
        if name == "LOCK" || !entry.path().is_file() {
            continue;
        }
        std::fs::copy(entry.path(), copy.join(&name))
            .map_err(|e| Error::Migration(format!("{}: {e}", entry.path().display())))?;
    }
    let result = (|| {
        let options = Options { create_if_missing: false, ..Options::default() };
        let mut db = DB::open(&copy, options).map_err(|e| Error::Migration(e.to_string()))?;
        let (keys, undecodable) = rows(&mut db, origin)?;
        Ok(Seed { keys, undecodable })
    })();
    let _ = std::fs::remove_dir_all(&copy);
    result
}

/// Writes a `Local Storage/leveldb` folder holding `keys` for `origin`. For tests and for
/// preparing a profile to try the carry-over with.
pub fn write_local_storage(leveldb: &Path, origin: &str, keys: &BTreeMap<String, String>) -> Result<(), Error> {
    let options = Options { create_if_missing: true, ..Options::default() };
    let mut db = DB::open(leveldb, options).map_err(|e| Error::Migration(e.to_string()))?;
    let fail = |e: rusty_leveldb::Status| Error::Migration(e.to_string());
    db.put(format!("META:{origin}").as_bytes(), &[8, 1]).map_err(fail)?;
    for (key, value) in keys {
        let mut row = format!("_{origin}\0").into_bytes();
        row.extend(encode(key));
        db.put(&row, &encode(value)).map_err(fail)?;
    }
    db.flush().map_err(fail)
}

/// The one-time marker in the shell's data folder.
#[derive(Debug, Clone)]
pub struct Marker {
    path: PathBuf,
}

impl Marker {
    pub fn new(data_dir: &Path) -> Self {
        Marker { path: data_dir.join(MARKER_FILE) }
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Records that the carry-over is over, with what it did.
    pub fn write(&self, at_ms: u64, keys: usize, source: Option<&Path>) -> Result<(), Error> {
        let body = serde_json::json!({ "at": at_ms, "keys": keys, "source": source.map(|p| p.to_string_lossy()) });
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::Migration(e.to_string()))?;
        }
        std::fs::write(&self.path, body.to_string()).map_err(|e| Error::Migration(e.to_string()))
    }
}

/// Decides what the first launch carries over: nothing once the marker exists, nothing when
/// there is no old profile (the marker is written at once, so later launches do not look
/// again), else the old profile's keys. A store that cannot be read is tried again next
/// launch.
pub fn plan(data_dir: &Path, electron_profile: Option<&Path>, now_ms: u64) -> Option<Seed> {
    let marker = Marker::new(data_dir);
    if marker.exists() {
        return None;
    }
    let leveldb = electron_profile.map(|p| p.join("Local Storage").join("leveldb")).filter(|p| p.is_dir());
    let Some(leveldb) = leveldb else {
        let _ = marker.write(now_ms, 0, None);
        return None;
    };
    match read_local_storage(&leveldb, ELECTRON_ORIGIN, data_dir) {
        Ok(seed) if seed.keys.is_empty() => {
            let _ = marker.write(now_ms, 0, Some(&leveldb));
            None
        }
        Ok(seed) => Some(seed),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn both_encodings_decode() {
        assert_eq!(decode(&[1, b'a', b'b', 0xe9]).as_deref(), Some("abé"));
        assert_eq!(decode(&[0, 0x3c, 0x04, 0x3d, 0xd8, 0x00, 0xde]).as_deref(), Some("м😀"));
        assert_eq!(decode(&[1]).as_deref(), Some(""));
        assert_eq!(decode(&[]), None);
        assert_eq!(decode(&[7, b'x']), None, "unknown encoding byte");
        assert_eq!(decode(&[0, 0x41]), None, "odd UTF-16 length");
        assert_eq!(decode(&[0, 0x00, 0xd8]), None, "lone surrogate");
    }

    #[test]
    fn encode_picks_latin1_when_it_fits() {
        for text in ["", "plain", "café", "Türkçe ğüşiöç", "日本語", "mixed 😀 text"] {
            let bytes = encode(text);
            assert_eq!(bytes[0], if text.chars().all(|c| (c as u32) < 256) { 1 } else { 0 }, "{text}");
            assert_eq!(decode(&bytes).as_deref(), Some(text));
        }
    }

    #[test]
    fn reads_one_origin_from_a_copy_and_leaves_the_original_alone() {
        let dir = Dir::new("migrate");
        let store = dir.path().join("profile/Local Storage/leveldb");
        std::fs::create_dir_all(&store).unwrap();
        let keys = map(&[
            ("cm:theme", "dark"),
            ("cm:draft", "ğüş — notlar 😀"),
            ("cm:paneTree", "{\"t\":\"leaf\"}"),
            ("empty", ""),
        ]);
        write_local_storage(&store, ELECTRON_ORIGIN, &keys).unwrap();
        write_local_storage(&store, "https://other.example", &map(&[("cm:theme", "light"), ("x", "y")])).unwrap();
        std::fs::write(store.join("LOCK"), b"held").unwrap();
        let before: Vec<_> = std::fs::read_dir(&store)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name(), e.metadata().unwrap().len()))
            .collect();

        let seed = read_local_storage(&store, ELECTRON_ORIGIN, dir.path()).unwrap();
        assert_eq!(seed.keys, keys);
        assert_eq!(seed.undecodable, 0);

        let mut after: Vec<_> = std::fs::read_dir(&store)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name(), e.metadata().unwrap().len()))
            .collect();
        let mut before = before;
        before.sort();
        after.sort();
        assert_eq!(before, after, "the original store must not change");
        assert!(!dir.path().join("leveldb-copy").exists(), "the scratch copy is removed");
    }

    #[test]
    fn undecodable_rows_are_counted_and_skipped() {
        let dir = Dir::new("migrate-bad");
        let store = dir.path().join("leveldb");
        write_local_storage(&store, ELECTRON_ORIGIN, &map(&[("good", "1")])).unwrap();
        {
            let mut db = DB::open(&store, Options::default()).unwrap();
            let mut row = format!("_{ELECTRON_ORIGIN}\0").into_bytes();
            row.extend(encode("bad"));
            db.put(&row, &[9, 9, 9]).unwrap();
            db.flush().unwrap();
        }
        let seed = read_local_storage(&store, ELECTRON_ORIGIN, dir.path()).unwrap();
        assert_eq!(seed.keys, map(&[("good", "1")]));
        assert_eq!(seed.undecodable, 1);
    }

    #[test]
    fn the_plan_runs_once() {
        let dir = Dir::new("migrate-plan");
        let profile = dir.path().join("Eos");
        let store = profile.join("Local Storage/leveldb");
        std::fs::create_dir_all(&store).unwrap();
        write_local_storage(&store, ELECTRON_ORIGIN, &map(&[("cm:theme", "light")])).unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();

        // First launch: the keys, and no marker until the page confirms.
        let seed = plan(&data, Some(&profile), 1).expect("seed");
        assert_eq!(seed.keys, map(&[("cm:theme", "light")]));
        assert!(!Marker::new(&data).exists());
        // The page did not confirm (a crash): the next launch offers them again.
        assert!(plan(&data, Some(&profile), 2).is_some());
        // Confirmed: never read again, even if the old profile changes.
        Marker::new(&data).write(3, 1, Some(&store)).unwrap();
        write_local_storage(&store, ELECTRON_ORIGIN, &map(&[("later", "x")])).unwrap();
        assert_eq!(plan(&data, Some(&profile), 4), None);
    }

    #[test]
    fn no_old_profile_marks_at_once() {
        let dir = Dir::new("migrate-none");
        assert_eq!(plan(dir.path(), None, 1), None);
        assert!(Marker::new(dir.path()).exists());

        let dir = Dir::new("migrate-missing");
        assert_eq!(plan(dir.path(), Some(&dir.path().join("no-such-profile")), 1), None);
        assert!(Marker::new(dir.path()).exists());
    }

    #[test]
    fn an_unreadable_store_is_tried_again() {
        let dir = Dir::new("migrate-broken");
        let store = dir.path().join("Eos/Local Storage/leveldb");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("CURRENT"), b"MANIFEST-999999\n").unwrap();
        assert_eq!(plan(dir.path(), Some(&dir.path().join("Eos")), 1), None);
        assert!(!Marker::new(dir.path()).exists());
    }
}
