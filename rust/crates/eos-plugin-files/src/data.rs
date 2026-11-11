//! A plugin's switches, settings and stored values, kept apart from its source
//! folder (an agent rewriting the folder never touches them):
//!
//! ```text
//! <root>/enabled.json            { [pluginId]: boolean }
//! <root>/<pluginId>/settings.json
//! <root>/<pluginId>/store.json   { [key]: value }
//! <root>/installed.json          { [pluginId]: where it was installed from }
//! ```
//!
//! JSON with two-space indentation, as today. Every write replaces the file
//! atomically; a read-modify-write of one store is one writer at a time.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use eos_contracts::PluginInstallRecord;
use eos_core::Error;
use eos_core::plugin::{PluginDataStore, PluginInstallStore};
use eos_kit_fs::{WriteOptions, atomic_write};
use indexmap::IndexMap;
use serde_json::{Map, Value};

/// The file's object, or an empty one when it is missing or not an object.
fn read_json(file: &Path) -> Map<String, Value> {
    match fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn write_json(file: &Path, value: &Map<String, Value>) -> Result<(), Error> {
    let text = serde_json::to_string_pretty(value).map_err(Error::storage)?;
    atomic_write(file, text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)
}

/// A plugin's own folder under the data root. An id is one path segment; one
/// that is not would name a file somewhere else.
fn plugin_file(root: &Path, id: &str, name: &str) -> Result<PathBuf, Error> {
    let mut parts = Path::new(id).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(_)), None) if !id.contains(['/', '\\']) => Ok(root.join(id).join(name)),
        _ => Err(Error::Validation(format!("not a plugin id: {id}"))),
    }
}

/// When the file last changed, as far as the filesystem tells.
type Stamp = Option<(SystemTime, u64)>;

fn stamp(file: &Path) -> Stamp {
    let meta = fs::metadata(file).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

#[derive(Debug)]
pub struct FsPluginDataStore {
    root: PathBuf,
    /// The switches as last read, with the file's stamp. They are asked for
    /// on every request to a built-in plugin's routes and for every agent
    /// event, so the file is re-read only when it changed. Also the lock
    /// that makes each read-modify-write one writer at a time.
    switches: Mutex<Option<(Stamp, HashMap<String, bool>)>>,
}

impl FsPluginDataStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into(), switches: Mutex::new(None) }
    }

    fn enabled_file(&self) -> PathBuf {
        self.root.join("enabled.json")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(Stamp, HashMap<String, bool>)>> {
        self.switches.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl PluginDataStore for FsPluginDataStore {
    fn enabled(&self, id: &str) -> Option<bool> {
        let file = self.enabled_file();
        let now = stamp(&file);
        let mut cached = self.lock();
        match cached.as_ref() {
            Some((seen, switches)) if *seen == now => switches.get(id).copied(),
            _ => {
                let switches: HashMap<String, bool> =
                    read_json(&file).into_iter().filter_map(|(id, on)| Some((id, on.as_bool()?))).collect();
                let on = switches.get(id).copied();
                *cached = Some((now, switches));
                on
            }
        }
    }

    fn set_enabled(&self, id: &str, on: bool) -> Result<(), Error> {
        let file = self.enabled_file();
        let mut cached = self.lock();
        let mut all = read_json(&file);
        all.insert(id.to_owned(), Value::Bool(on));
        write_json(&file, &all)?;
        // Read again on the next ask: the stamp of what was just written is the file's to tell.
        *cached = None;
        Ok(())
    }

    fn settings(&self, id: &str) -> Map<String, Value> {
        plugin_file(&self.root, id, "settings.json").map(|file| read_json(&file)).unwrap_or_default()
    }

    fn set_settings(&self, id: &str, values: &Map<String, Value>) -> Result<(), Error> {
        let _one_writer = self.lock();
        write_json(&plugin_file(&self.root, id, "settings.json")?, values)
    }

    fn store_value(&self, id: &str, key: &str) -> Option<Value> {
        let file = plugin_file(&self.root, id, "store.json").ok()?;
        read_json(&file).remove(key)
    }

    fn set_store_value(&self, id: &str, key: &str, value: Option<Value>) -> Result<(), Error> {
        let file = plugin_file(&self.root, id, "store.json")?;
        let _one_writer = self.lock();
        let mut all = read_json(&file);
        match value {
            Some(value) if !value.is_null() => {
                all.insert(key.to_owned(), value);
            }
            _ => {
                all.shift_remove(key);
            }
        }
        write_json(&file, &all)
    }
}

/// `installed.json`: where each installed plugin came from.
#[derive(Debug)]
pub struct FsPluginInstallStore {
    file: PathBuf,
    one_writer: Mutex<()>,
}

impl FsPluginInstallStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self { file: root.as_ref().join("installed.json"), one_writer: Mutex::new(()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.one_writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl PluginInstallStore for FsPluginInstallStore {
    /// The records that read as records; anything else in the file is left alone.
    fn all(&self) -> IndexMap<String, PluginInstallRecord> {
        read_json(&self.file)
            .into_iter()
            .filter_map(|(id, raw)| Some((id, eos_contracts::parse::<PluginInstallRecord>(&raw).ok()?)))
            .collect()
    }

    fn get(&self, id: &str) -> Option<PluginInstallRecord> {
        read_json(&self.file).get(id).and_then(|raw| eos_contracts::parse(raw).ok())
    }

    fn set(&self, id: &str, record: &PluginInstallRecord) -> Result<(), Error> {
        let _one_writer = self.lock();
        let mut all = read_json(&self.file);
        all.insert(id.to_owned(), serde_json::to_value(record).map_err(Error::storage)?);
        write_json(&self.file, &all)
    }

    fn remove(&self, id: &str) -> Result<(), Error> {
        let _one_writer = self.lock();
        let mut all = read_json(&self.file);
        all.shift_remove(id);
        write_json(&self.file, &all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_contracts::{Num, PluginSource, PluginSourceNpm};
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn switches_are_kept_and_follow_the_file() {
        let root = tempfile::tempdir().expect("a folder");
        let store = FsPluginDataStore::new(root.path());
        assert_eq!(store.enabled("clock"), None);
        store.set_enabled("clock", false).expect("writes");
        store.set_enabled("eos.pages", true).expect("writes");
        assert_eq!(store.enabled("clock"), Some(false));
        assert_eq!(store.enabled("eos.pages"), Some(true));
        // Today's on-disk form: JSON.stringify(value, null, 2).
        assert_eq!(
            fs::read_to_string(root.path().join("enabled.json")).expect("the file"),
            "{\n  \"clock\": false,\n  \"eos.pages\": true\n}"
        );

        // An edit made outside the app is seen; a value that is no switch counts as never set.
        fs::write(
            root.path().join("enabled.json"),
            r#"{"clock": true, "notes": "yes", "extra-long-so-the-size-differs": false}"#,
        )
        .expect("writes");
        assert_eq!(store.enabled("clock"), Some(true));
        assert_eq!(store.enabled("notes"), None);
        fs::write(root.path().join("enabled.json"), "[1, 2]").expect("writes");
        assert_eq!(store.enabled("clock"), None, "not an object: nothing is set");
    }

    #[test]
    fn settings_and_stored_values_live_in_the_plugins_own_folder() {
        let root = tempfile::tempdir().expect("a folder");
        let store = FsPluginDataStore::new(root.path());
        assert!(store.settings("clock").is_empty());
        store.set_settings("clock", &object(json!({"seconds": true, "zone": "utc"}))).expect("writes");
        assert_eq!(store.settings("clock"), object(json!({"seconds": true, "zone": "utc"})));
        assert_eq!(
            fs::read_to_string(root.path().join("clock/settings.json")).expect("the file"),
            "{\n  \"seconds\": true,\n  \"zone\": \"utc\"\n}"
        );

        assert_eq!(store.store_value("clock", "list"), None);
        store.set_store_value("clock", "list", Some(json!([{"text": "hi"}]))).expect("writes");
        store.set_store_value("clock", "count", Some(json!(2))).expect("writes");
        assert_eq!(store.store_value("clock", "list"), Some(json!([{"text": "hi"}])));
        assert_eq!(
            fs::read_to_string(root.path().join("clock/store.json")).expect("the file"),
            "{\n  \"list\": [\n    {\n      \"text\": \"hi\"\n    }\n  ],\n  \"count\": 2\n}"
        );
        store.set_store_value("clock", "list", None).expect("writes");
        store.set_store_value("clock", "count", Some(Value::Null)).expect("writes");
        assert_eq!(store.store_value("clock", "list"), None);
        assert_eq!(fs::read_to_string(root.path().join("clock/store.json")).expect("the file"), "{}");
    }

    #[test]
    fn an_id_that_is_not_one_folder_name_reaches_no_file() {
        let root = tempfile::tempdir().expect("a folder");
        let data = root.path().join("data");
        let store = FsPluginDataStore::new(&data);
        for id in ["..", "../x", "a/b", "", ".", "/abs"] {
            assert!(store.set_settings(id, &Map::new()).is_err(), "{id:?}");
            assert!(store.set_store_value(id, "k", Some(json!(1))).is_err(), "{id:?}");
            assert!(store.settings(id).is_empty());
            assert_eq!(store.store_value(id, "k"), None);
        }
        assert!(!root.path().join("settings.json").exists() && !root.path().join("x").exists());
    }

    #[test]
    fn concurrent_writers_lose_nothing() {
        let root = tempfile::tempdir().expect("a folder");
        let store = std::sync::Arc::new(FsPluginDataStore::new(root.path()));
        let writers: Vec<_> = (0..8)
            .map(|w| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for i in 0..20 {
                        store.set_store_value("clock", &format!("k{w}-{i}"), Some(json!(i))).expect("writes");
                        store.set_enabled(&format!("p{w}-{i}"), true).expect("writes");
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().expect("a writer");
        }
        assert_eq!(read_json(&root.path().join("clock/store.json")).len(), 160);
        assert_eq!(read_json(&root.path().join("enabled.json")).len(), 160);
    }

    #[test]
    fn install_records_are_kept_and_bad_ones_skipped() {
        let root = tempfile::tempdir().expect("a folder");
        let store = FsPluginInstallStore::new(root.path());
        assert!(store.all().is_empty());
        let record = PluginInstallRecord {
            source: PluginSource::Npm(PluginSourceNpm { name: "eos-clock".into(), version: Some("1.0.0".into()) }),
            resolved: "https://r/eos-clock-1.0.0.tgz".into(),
            integrity: Some("sha512-abc".into()),
            version: Some("1.0.0".into()),
            installed_at: Num(42.0),
        };
        store.set("clock", &record).expect("writes");
        assert_eq!(store.get("clock"), Some(record.clone()));
        assert_eq!(
            fs::read_to_string(root.path().join("installed.json")).expect("the file"),
            "{\n  \"clock\": {\n    \"source\": {\n      \"kind\": \"npm\",\n      \"name\": \"eos-clock\",\n      \"version\": \"1.0.0\"\n    },\n    \"resolved\": \"https://r/eos-clock-1.0.0.tgz\",\n    \"integrity\": \"sha512-abc\",\n    \"version\": \"1.0.0\",\n    \"installedAt\": 42\n  }\n}"
        );

        // A hand-edited entry that is no record is not listed, and survives the next write.
        let mut raw = read_json(&root.path().join("installed.json"));
        raw.insert("odd".into(), json!({"source": "somewhere"}));
        write_json(&root.path().join("installed.json"), &raw).expect("writes");
        assert_eq!(store.all().keys().collect::<Vec<_>>(), ["clock"]);
        assert_eq!(store.get("odd"), None);
        store.remove("clock").expect("writes");
        assert!(store.all().is_empty());
        assert!(read_json(&root.path().join("installed.json")).contains_key("odd"));
    }
}
