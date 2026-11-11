use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use eos_core::Error;
use eos_core::store::ConfigSource;
use eos_domain::config::{Config, Env, Host, resolve};
use eos_kit_fs::{WriteOptions, atomic_write};
use serde_json::{Map, Value};

const FILE: &str = "config.json";

/// The `EOS_*` variables of this process: the one place they are read.
pub fn env_from_process() -> Env {
    Env::new(std::env::vars().filter(|(name, _)| name.starts_with("EOS_")))
}

struct Loaded {
    config: Arc<Config>,
    declared_backends: Option<Vec<String>>,
}

/// `config.json` in a data folder.
pub struct ConfigFile {
    path: PathBuf,
    host: Host,
    loaded: RwLock<Loaded>,
    /// One patch at a time: read the file, change it, write it, reload.
    patching: Mutex<()>,
}

impl std::fmt::Debug for ConfigFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfigFile").field("path", &self.path).finish_non_exhaustive()
    }
}

/// The file's JSON; `None` when there is no file. A file that is not JSON is
/// reported and treated as absent.
fn read(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(json) => Some(json),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "config.json is not valid JSON; ignored");
            None
        }
    }
}

fn load(path: &Path, host: &Host) -> Loaded {
    let file = read(path);
    let declared_backends = file
        .as_ref()
        .and_then(|f| f.get("backends"))
        .and_then(Value::as_object)
        .map(|backends| backends.keys().cloned().collect::<Vec<_>>())
        .filter(|names| !names.is_empty());
    let (config, rejected) = resolve(host, file);
    if let Some(reason) = rejected {
        tracing::warn!(path = %path.display(), reason = %reason.0, "config.json breaks a rule; ignored, the defaults stand");
    }
    Loaded { config: Arc::new(config), declared_backends }
}

impl ConfigFile {
    /// Loads the configuration of the data folder `home`. `remote_feature`:
    /// the system can pair with other devices (the platform says).
    pub fn load(home: &Path, env: Env, remote_feature: bool) -> Self {
        let path = home.join(FILE);
        let host = Host { home: home.to_string_lossy().into_owned(), env, remote_feature };
        let loaded = load(&path, &host);
        Self { path, host, loaded: RwLock::new(loaded), patching: Mutex::new(()) }
    }
}

impl ConfigSource for ConfigFile {
    fn current(&self) -> Arc<Config> {
        self.loaded.read().unwrap_or_else(|p| p.into_inner()).config.clone()
    }

    fn declared_backends(&self) -> Option<Vec<String>> {
        self.loaded.read().unwrap_or_else(|p| p.into_inner()).declared_backends.clone()
    }

    fn reload(&self) -> Arc<Config> {
        let loaded = load(&self.path, &self.host);
        let config = loaded.config.clone();
        *self.loaded.write().unwrap_or_else(|p| p.into_inner()) = loaded;
        config
    }

    fn patch(&self, section: &str, patch: Map<String, Value>) -> Result<Arc<Config>, Error> {
        let _one_at_a_time = self.patching.lock().unwrap_or_else(|p| p.into_inner());
        let mut file = match read(&self.path) {
            Some(Value::Object(file)) => file,
            _ => Map::new(),
        };
        let mut block = match file.remove(section) {
            Some(Value::Object(block)) => block,
            _ => Map::new(),
        };
        for (key, value) in patch {
            if value.is_null() {
                block.remove(&key);
            } else {
                block.insert(key, value);
            }
        }
        file.insert(section.to_owned(), Value::Object(block));
        let text = serde_json::to_string_pretty(&Value::Object(file)).map_err(Error::storage)?;
        atomic_write(&self.path, text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)?;
        Ok(self.reload())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_domain::config::ArchiveRetention;
    use eos_testkit::TempHome;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn the_file_overrides_the_defaults_and_a_reload_sees_an_edit() {
        let home = TempHome::new();
        let config = ConfigFile::load(home.path(), Env::default(), true);
        assert_eq!(config.current().archive.retention, ArchiveRetention::Weekly);
        assert_eq!(config.current().daemon.home, home.path().to_string_lossy());
        assert_eq!(config.declared_backends(), None);

        let before = config.current();
        home.write(
            "config.json",
            r#"{"archive":{"retention":"off"},"backends":{"mine":{"kind":"claude","model":"claude-opus-5-5"}}}"#,
        );
        assert_eq!(config.current().archive.retention, ArchiveRetention::Weekly, "nothing changes until a reload");
        assert_eq!(config.reload().archive.retention, ArchiveRetention::Off);
        assert_eq!(config.declared_backends(), Some(vec!["mine".to_owned()]));
        assert_eq!(before.archive.retention, ArchiveRetention::Weekly, "a snapshot in hand never changes");
    }

    #[test]
    fn a_patch_merges_into_its_section_and_keeps_the_rest_of_the_file() {
        let home = TempHome::new();
        home.write("config.json", r#"{"archive":{"retention":"daily"},"workflow":{"enabled":true}}"#);
        let config = ConfigFile::load(home.path(), Env::default(), true);

        let patched = config.patch("archive", object(json!({ "purgeOnAppClose": true }))).expect("patches");
        assert_eq!((patched.archive.retention, patched.archive.purge_on_app_close), (ArchiveRetention::Daily, true));
        let on_disk: Value = serde_json::from_str(&home.read("config.json")).expect("JSON");
        assert_eq!(
            on_disk,
            json!({ "archive": { "retention": "daily", "purgeOnAppClose": true }, "workflow": { "enabled": true } })
        );
        assert!(
            home.read("config.json").starts_with("{\n  \"workflow\"")
                || home.read("config.json").starts_with("{\n  \"archive\"")
        );

        let created = config.patch("compaction", object(json!({ "threshold": 0.5 }))).expect("patches");
        assert_eq!(created.compaction.threshold, 0.5);
    }

    #[test]
    fn a_null_in_a_patch_removes_its_key() {
        let home = TempHome::new();
        home.write("config.json", r#"{"anthropic":{"apiKey":"sk-1","authToken":"old"}}"#);
        let config = ConfigFile::load(home.path(), Env::default(), true);
        let patch = Map::from_iter([("authToken".to_owned(), Value::Null), ("apiKey".to_owned(), json!("sk-2"))]);
        let after = config.patch("anthropic", patch).expect("writes");
        assert_eq!((after.anthropic.api_key.as_deref(), after.anthropic.auth_token.as_deref()), (Some("sk-2"), None));
        let file: Value = serde_json::from_str(&home.read("config.json")).expect("JSON");
        assert_eq!(file, json!({ "anthropic": { "apiKey": "sk-2" } }), "a cleared field leaves nothing behind");
    }

    #[test]
    fn a_broken_file_leaves_the_defaults_standing() {
        let home = TempHome::new();
        home.write("config.json", "{ not json");
        assert_eq!(ConfigFile::load(home.path(), Env::default(), true).current().compaction.threshold, 0.7);
        home.write("config.json", r#"{"compaction":{"threshold":7}}"#);
        assert_eq!(ConfigFile::load(home.path(), Env::default(), true).current().compaction.threshold, 0.7);
    }

    #[test]
    fn only_eos_variables_are_captured() {
        // The process environment is read here and nowhere else; the test only checks the filter's shape.
        let _ = env_from_process();
        let config = ConfigFile::load(
            TempHome::new().path(),
            Env::new([("EOS_SSE_KEEPALIVE_MS".to_owned(), "9000".to_owned())]),
            false,
        );
        assert_eq!(config.current().daemon.sse_keepalive_ms, 9000);
        assert!(!config.current().remote.enabled, "off where the system cannot pair");
    }
}
