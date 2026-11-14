//! Fakes of the plugin ports (`eos_core::plugin`): plugin folders, the
//! builder, plugin data, install staging, the sources and the previewer —
//! all in memory.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{PluginInstallRecord, PluginPreviewResult, PluginSource};
use eos_core::plugin::{
    FetchedPlugin, NewStage, OnPluginChange, PluginBuild, PluginBuilder, PluginDataStore, PluginFetcher, PluginFolder,
    PluginInstallStore, PluginPreviewCall, PluginPreviewFiles, PluginPreviewer, PluginStaging, PluginWorkspace,
    StagedFolder, WatchGuard,
};
use eos_core::{BoxFuture, Error};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::sync::Semaphore;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn ready<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

/// A folder's `plugin.json` text and its top-level file names.
type FolderContent = (Option<String>, Vec<String>);

/// Plugin folders in memory under `/p`. [`change`](Self::change) plays the watcher.
#[derive(Default)]
pub struct FakePluginWorkspace {
    folders: Mutex<BTreeMap<String, FolderContent>>,
    watcher: Arc<Mutex<Option<OnPluginChange>>>,
}

impl std::fmt::Debug for FakePluginWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakePluginWorkspace").field("folders", &lock(&self.folders).keys()).finish_non_exhaustive()
    }
}

impl FakePluginWorkspace {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds or replaces a folder: its `plugin.json` text (if any) and its top-level file names.
    pub fn put(&self, id: &str, manifest: Option<&str>, files: &[&str]) {
        let files = files.iter().map(|f| (*f).to_owned()).collect();
        lock(&self.folders).insert(id.to_owned(), (manifest.map(str::to_owned), files));
    }

    pub fn remove(&self, id: &str) {
        lock(&self.folders).remove(id);
    }

    /// Reports a change to `id`, as the watcher would. Nothing happens while nobody watches.
    pub fn change(&self, id: &str) {
        let watcher = lock(&self.watcher).clone();
        if let Some(on_change) = watcher {
            on_change(id);
        }
    }

    pub fn is_watched(&self) -> bool {
        lock(&self.watcher).is_some()
    }
}

impl PluginWorkspace for FakePluginWorkspace {
    fn root(&self) -> &Path {
        Path::new("/p")
    }

    fn list(&self) -> Vec<PluginFolder> {
        let ids: Vec<String> = lock(&self.folders).keys().cloned().collect();
        ids.iter().filter_map(|id| self.read(id)).collect()
    }

    fn read(&self, id: &str) -> Option<PluginFolder> {
        let (manifest_text, files) = lock(&self.folders).get(id)?.clone();
        Some(PluginFolder { id: id.to_owned(), dir: PathBuf::from(format!("/p/{id}")), manifest_text, files })
    }

    fn watch(&self, on_change: OnPluginChange) -> Result<WatchGuard, Error> {
        *lock(&self.watcher) = Some(on_change);
        Ok(Box::new(Unwatch(self.watcher.clone())))
    }
}

/// Ends the fake watch when the guard is dropped, as a real watcher does.
struct Unwatch(Arc<Mutex<Option<OnPluginChange>>>);

impl Drop for Unwatch {
    fn drop(&mut self) {
        *lock(&self.0) = None;
    }
}

/// A builder that answers `// <dir>` and records what it was asked to build.
#[derive(Debug)]
pub struct FakePluginBuilder {
    builds: Mutex<Vec<String>>,
    fail_next: Mutex<Option<String>>,
    css: Mutex<Option<String>>,
    /// Builds pass one permit at a time; [`hold`](Self::hold) takes them away.
    gate: Semaphore,
}

impl Default for FakePluginBuilder {
    fn default() -> Self {
        Self {
            builds: Mutex::default(),
            fail_next: Mutex::default(),
            css: Mutex::default(),
            gate: Semaphore::new(Semaphore::MAX_PERMITS),
        }
    }
}

impl FakePluginBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// `<dir>/<entry>` of every build asked for, in order.
    pub fn builds(&self) -> Vec<String> {
        lock(&self.builds).clone()
    }

    pub fn clear(&self) {
        lock(&self.builds).clear();
    }

    /// The next build fails with `message`.
    pub fn fail_next(&self, message: &str) {
        *lock(&self.fail_next) = Some(message.to_owned());
    }

    /// Builds answer this stylesheet from now on.
    pub fn with_css(&self, css: &str) {
        *lock(&self.css) = Some(css.to_owned());
    }

    /// Builds started from now on wait until [`release`](Self::release).
    pub fn hold(&self) {
        self.gate.forget_permits(Semaphore::MAX_PERMITS);
    }

    /// Lets `builds` waiting builds through.
    pub fn release(&self, builds: usize) {
        self.gate.add_permits(builds);
    }
}

impl PluginBuilder for FakePluginBuilder {
    fn build<'a>(&'a self, dir: &'a Path, entry: &'a str) -> BoxFuture<'a, Result<PluginBuild, Error>> {
        Box::pin(async move {
            lock(&self.builds).push(format!("{}/{entry}", dir.display()));
            if let Ok(permit) = self.gate.acquire().await {
                permit.forget();
            }
            if let Some(message) = lock(&self.fail_next).take() {
                return Err(Error::Rule(message));
            }
            Ok(PluginBuild { js: format!("// {}", dir.display()), css: lock(&self.css).clone() })
        })
    }
}

/// Switches, settings and stored values in memory.
#[derive(Debug, Default)]
pub struct FakePluginDataStore {
    enabled: Mutex<HashMap<String, bool>>,
    settings: Mutex<HashMap<String, Map<String, Value>>>,
    store: Mutex<HashMap<String, Map<String, Value>>>,
}

impl FakePluginDataStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PluginDataStore for FakePluginDataStore {
    fn enabled(&self, id: &str) -> Option<bool> {
        lock(&self.enabled).get(id).copied()
    }

    fn set_enabled(&self, id: &str, on: bool) -> Result<(), Error> {
        lock(&self.enabled).insert(id.to_owned(), on);
        Ok(())
    }

    fn settings(&self, id: &str) -> Map<String, Value> {
        lock(&self.settings).get(id).cloned().unwrap_or_default()
    }

    fn set_settings(&self, id: &str, values: &Map<String, Value>) -> Result<(), Error> {
        lock(&self.settings).insert(id.to_owned(), values.clone());
        Ok(())
    }

    fn store_value(&self, id: &str, key: &str) -> Option<Value> {
        lock(&self.store).get(id)?.get(key).cloned()
    }

    fn set_store_value(&self, id: &str, key: &str, value: Option<Value>) -> Result<(), Error> {
        let mut store = lock(&self.store);
        let values = store.entry(id.to_owned()).or_default();
        match value {
            Some(value) if !value.is_null() => {
                values.insert(key.to_owned(), value);
            }
            _ => {
                values.shift_remove(key);
            }
        }
        Ok(())
    }
}

/// A staging area in memory under `/stage`. Every new stage holds
/// [`staged`](Self::staged)'s folder; calls are recorded.
#[derive(Debug)]
pub struct FakePluginStaging {
    template: Mutex<StagedFolder>,
    stages: Mutex<HashMap<String, StagedFolder>>,
    folders: Mutex<HashSet<String>>,
    calls: Mutex<Vec<String>>,
    next: Mutex<u32>,
}

impl Default for FakePluginStaging {
    fn default() -> Self {
        Self {
            template: Mutex::new(StagedFolder {
                manifest_text: Some(r#"{"id":"clock","name":"Clock","version":"1.0.0"}"#.to_owned()),
                top_files: vec!["plugin.json".to_owned(), "ui.jsx".to_owned()],
                files: 2,
                bytes: 300,
            }),
            stages: Mutex::default(),
            folders: Mutex::default(),
            calls: Mutex::default(),
            next: Mutex::new(0),
        }
    }
}

impl FakePluginStaging {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the next fetched plugin's `plugin.json` holds (`None`: no such file).
    pub fn staged(&self, manifest: Option<&str>) {
        lock(&self.template).manifest_text = manifest.map(str::to_owned);
    }

    /// A plugin folder that is already there.
    pub fn existing(&self, plugin_id: &str) {
        lock(&self.folders).insert(plugin_id.to_owned());
    }

    /// `promote:<stage>-><plugin>`, `trash:<plugin>`, `discard:<stage>`, `clear`, in order.
    pub fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }
}

impl PluginStaging for FakePluginStaging {
    fn create(&self) -> Result<NewStage, Error> {
        let mut next = lock(&self.next);
        *next += 1;
        let id = format!("st-{:08}", *next);
        lock(&self.stages).insert(id.clone(), lock(&self.template).clone());
        Ok(NewStage { dir: PathBuf::from(format!("/stage/{id}")), id })
    }

    fn dir(&self, id: &str) -> Option<PathBuf> {
        lock(&self.stages).contains_key(id).then(|| PathBuf::from(format!("/stage/{id}")))
    }

    fn inspect(&self, id: &str) -> Result<StagedFolder, Error> {
        lock(&self.stages).get(id).cloned().ok_or_else(|| Error::not_found("staged plugin", id))
    }

    fn discard(&self, id: &str) {
        lock(&self.calls).push(format!("discard:{id}"));
        lock(&self.stages).remove(id);
    }

    fn clear(&self) {
        lock(&self.calls).push("clear".to_owned());
        lock(&self.stages).clear();
    }

    fn promote(&self, id: &str, plugin_id: &str) -> Result<(), Error> {
        if lock(&self.stages).remove(id).is_none() {
            return Err(Error::not_found("staged plugin", id));
        }
        lock(&self.calls).push(format!("promote:{id}->{plugin_id}"));
        lock(&self.folders).insert(plugin_id.to_owned());
        Ok(())
    }

    fn trash(&self, plugin_id: &str) -> Result<(), Error> {
        lock(&self.calls).push(format!("trash:{plugin_id}"));
        lock(&self.folders).remove(plugin_id);
        Ok(())
    }

    fn has(&self, plugin_id: &str) -> bool {
        lock(&self.folders).contains(plugin_id)
    }
}

/// A source that always "fetches" the same thing, recording what was asked.
#[derive(Debug)]
pub struct FakePluginFetcher {
    fetched: Mutex<Vec<PluginSource>>,
    answer: Mutex<Result<FetchedPlugin, Error>>,
}

impl Default for FakePluginFetcher {
    fn default() -> Self {
        Self {
            fetched: Mutex::default(),
            answer: Mutex::new(Ok(FetchedPlugin {
                resolved: "https://r/eos-clock-1.0.0.tgz".to_owned(),
                integrity: Some("sha512-abc".to_owned()),
            })),
        }
    }
}

impl FakePluginFetcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every source asked for, in order.
    pub fn fetched(&self) -> Vec<PluginSource> {
        lock(&self.fetched).clone()
    }

    /// Fetches fail with `error` from now on.
    pub fn fail(&self, error: Error) {
        *lock(&self.answer) = Err(error);
    }
}

impl PluginFetcher for FakePluginFetcher {
    fn fetch<'a>(&'a self, source: &'a PluginSource, _dir: &'a Path) -> BoxFuture<'a, Result<FetchedPlugin, Error>> {
        lock(&self.fetched).push(source.clone());
        ready(lock(&self.answer).clone())
    }
}

/// Install records in memory.
#[derive(Debug, Default)]
pub struct FakePluginInstallStore(Mutex<IndexMap<String, PluginInstallRecord>>);

impl FakePluginInstallStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PluginInstallStore for FakePluginInstallStore {
    fn all(&self) -> IndexMap<String, PluginInstallRecord> {
        lock(&self.0).clone()
    }

    fn get(&self, id: &str) -> Option<PluginInstallRecord> {
        lock(&self.0).get(id).cloned()
    }

    fn set(&self, id: &str, record: &PluginInstallRecord) -> Result<(), Error> {
        lock(&self.0).insert(id.to_owned(), record.clone());
        Ok(())
    }

    fn remove(&self, id: &str) -> Result<(), Error> {
        lock(&self.0).shift_remove(id);
        Ok(())
    }
}

/// A window shell that "draws" a fixed answer and records what it was asked.
#[derive(Debug)]
pub struct FakePluginPreviewer {
    available: bool,
    reply: PluginPreviewResult,
    calls: Mutex<Vec<PluginPreviewCall>>,
}

impl FakePluginPreviewer {
    /// `reply`: what every preview answers. `available: false` plays an app without a window.
    pub fn new(available: bool, reply: PluginPreviewResult) -> Self {
        Self { available, reply, calls: Mutex::default() }
    }

    pub fn calls(&self) -> Vec<PluginPreviewCall> {
        lock(&self.calls).clone()
    }
}

impl PluginPreviewer for FakePluginPreviewer {
    fn is_available(&self) -> bool {
        self.available
    }

    fn preview(&self, call: PluginPreviewCall) -> BoxFuture<'_, Result<PluginPreviewResult, Error>> {
        lock(&self.calls).push(call);
        ready(Ok(self.reply.clone()))
    }
}

/// Keeps "saved" pictures in memory and answers `/previews/<stem>.png`.
#[derive(Debug, Default)]
pub struct FakePluginPreviewFiles(Mutex<Vec<(String, Vec<u8>)>>);

impl FakePluginPreviewFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// `(stem, bytes)` of every picture saved.
    pub fn saved(&self) -> Vec<(String, Vec<u8>)> {
        lock(&self.0).clone()
    }
}

impl PluginPreviewFiles for FakePluginPreviewFiles {
    fn save(&self, stem: &str, png: &[u8]) -> Result<PathBuf, Error> {
        lock(&self.0).push((stem.to_owned(), png.to_vec()));
        Ok(PathBuf::from(format!("/previews/{stem}.png")))
    }
}
