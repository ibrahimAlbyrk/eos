//! `PluginService` — the one owner of plugin state. It keeps every plugin
//! folder in step with its built UI: a folder changing on disk rebuilds that
//! plugin and announces the new revision, which every window loads in place
//! of the old one. A failed build keeps the last good one running and reports
//! why. Switches, settings and stored values go through here too, so each
//! change is announced.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::{
    BUILTIN_PLUGIN_PREFIX, PLUGINS_TOPIC, PluginInfo, PluginManifest, PluginReport, PluginReportRequest,
    PluginSettingValue, PluginState, plugin_setting_values, plugin_store_topic,
};
use eos_core::plugin::{PluginBuilder, PluginDataStore, PluginStatus, PluginWorkspace, WatchGuard};
use eos_core::{Clock, Error};
use eos_runtime::bus::{Bus, Topic};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::AbortHandle;

use crate::manifest::{parse_plugin_manifest, plugin_ui_entry};

/// `plugins:change {id}` — a plugin was added, removed, rebuilt, toggled or re-set.
pub const PLUGINS_CHANGE: Topic<PluginChange> = Topic::new(PLUGINS_TOPIC);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginChange {
    pub id: String,
}

/// `plugin:<id>:store {key}` — one stored value changed.
#[derive(Serialize)]
struct StoreChange<'a> {
    key: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct PluginServiceOptions {
    /// Quiet window after a file change before rebuilding (an editor save
    /// often writes several times).
    pub debounce: Duration,
    /// How long [`PluginService::settled`] waits for a rebuild and a window.
    pub settle_timeout: Duration,
}

impl Default for PluginServiceOptions {
    fn default() -> Self {
        Self { debounce: Duration::from_millis(120), settle_timeout: Duration::from_secs(5) }
    }
}

/// A build as it is served: shared, never copied per request.
#[derive(Debug, Clone)]
pub struct Bundle {
    pub js: Bytes,
    pub css: Option<Bytes>,
}

struct Entry {
    /// `None` for a built-in.
    dir: Option<PathBuf>,
    manifest: Option<PluginManifest>,
    /// Manifest or build problem; `None` when the plugin is healthy.
    error: Option<String>,
    /// The last good build and its revision (0 = never built).
    build: Option<Bundle>,
    rev: i64,
}

struct State {
    entries: BTreeMap<String, Entry>,
    /// One build at a time per plugin; a change during a build reruns it after.
    running: HashMap<String, watch::Receiver<bool>>,
    again: HashSet<String>,
    /// Debounce timers, each with the number that tells it from its successor.
    timers: HashMap<String, (u64, AbortHandle)>,
    next_timer: u64,
    /// The latest word from a window about each plugin's build (loaded, or failed).
    reports: HashMap<String, PluginReport>,
    next_rev: i64,
    watch: Option<WatchGuard>,
}

pub struct PluginService {
    workspace: Arc<dyn PluginWorkspace>,
    builder: Arc<dyn PluginBuilder>,
    data: Arc<dyn PluginDataStore>,
    clock: Arc<dyn Clock>,
    bus: Bus,
    /// Features that ship with Eos and switch on and off like plugins (no folder, no build).
    builtins: Vec<PluginManifest>,
    options: PluginServiceOptions,
    state: Mutex<State>,
    /// Counts up whenever something [`settled`](Self::settled) looks at may have changed.
    moved: watch::Sender<u64>,
}

impl std::fmt::Debug for PluginService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginService").field("dir", &self.workspace.root()).finish_non_exhaustive()
    }
}

/// What the service is built from.
pub struct PluginServiceDeps {
    pub workspace: Arc<dyn PluginWorkspace>,
    pub builder: Arc<dyn PluginBuilder>,
    pub data: Arc<dyn PluginDataStore>,
    pub clock: Arc<dyn Clock>,
    pub bus: Bus,
    pub builtins: Vec<PluginManifest>,
    pub options: PluginServiceOptions,
}

impl std::fmt::Debug for PluginServiceDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginServiceDeps").field("options", &self.options).finish_non_exhaustive()
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(work).await.map_err(Error::storage)
}

/// One run of [`PluginService::reload`]. Ending it — also by a panic inside
/// the run — frees the plugin for the next one and wakes who waited.
struct Flight<'a> {
    service: &'a PluginService,
    id: &'a str,
    done: Option<watch::Sender<bool>>,
}

impl Flight<'_> {
    /// Ends this run. When a change arrived meanwhile, the next run is
    /// registered in the same step and its signal returned.
    fn end(&mut self) -> Option<watch::Sender<bool>> {
        let done = self.done.take()?;
        let next = {
            let mut state = self.service.lock();
            if state.again.remove(self.id) {
                let (next, running) = watch::channel(false);
                state.running.insert(self.id.to_owned(), running);
                Some(next)
            } else {
                state.running.remove(self.id);
                None
            }
        };
        done.send_replace(true);
        self.service.touch();
        next
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        if self.done.is_some() {
            // The run did not end by itself: no follow-up, but nobody waits forever.
            self.service.lock().again.remove(self.id);
            self.end();
        }
    }
}

impl PluginService {
    pub fn new(deps: PluginServiceDeps) -> Arc<Self> {
        let entries = deps
            .builtins
            .iter()
            .map(|manifest| {
                let entry = Entry { dir: None, manifest: Some(manifest.clone()), error: None, build: None, rev: 0 };
                (manifest.id.0.clone(), entry)
            })
            .collect();
        Arc::new(Self {
            workspace: deps.workspace,
            builder: deps.builder,
            data: deps.data,
            clock: deps.clock,
            bus: deps.bus,
            builtins: deps.builtins,
            options: deps.options,
            state: Mutex::new(State {
                entries,
                running: HashMap::new(),
                again: HashSet::new(),
                timers: HashMap::new(),
                next_timer: 0,
                reports: HashMap::new(),
                next_rev: 1,
                watch: None,
            }),
            moved: watch::Sender::new(0),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn touch(&self) {
        self.moved.send_modify(|n| *n = n.wrapping_add(1));
    }

    fn announce(&self, id: &str) {
        self.bus.publish(&PLUGINS_CHANGE, &PluginChange { id: id.to_owned() });
        self.touch();
    }

    fn is_builtin(&self, id: &str) -> bool {
        self.builtins.iter().any(|manifest| manifest.id.0 == id)
    }

    /// The saved switch, else on — unless the plugin marks itself experimental.
    fn enabled_for(&self, id: &str, manifest: Option<&PluginManifest>) -> bool {
        self.data.enabled(id).unwrap_or_else(|| !manifest.and_then(|m| m.experimental).unwrap_or(false))
    }

    /// The folder plugin folders live in.
    pub fn dir(&self) -> String {
        self.workspace.root().to_string_lossy().into_owned()
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        let experimental = match self.lock().entries.get(id) {
            Some(entry) => entry.manifest.as_ref().and_then(|m| m.experimental).unwrap_or(false),
            None => return false,
        };
        self.data.enabled(id).unwrap_or(!experimental)
    }

    /// Whether a feature gated by built-in plugin `id` is on. An id that is
    /// not a listed built-in gates nothing: such a feature is always on.
    pub fn is_feature_on(&self, id: &str) -> bool {
        !self.is_builtin(id) || self.is_enabled(id)
    }

    /// The name the user knows a built-in by.
    pub fn builtin_name(&self, id: &str) -> Option<&str> {
        self.builtins.iter().find(|manifest| manifest.id.0 == id).map(|manifest| manifest.name.as_str())
    }

    /// The built-ins switched off, for sessions starting now (their agent
    /// tools and prompt sections are left out).
    pub fn disabled_builtins(&self) -> Vec<String> {
        self.builtins.iter().map(|m| m.id.0.clone()).filter(|id| !self.is_enabled(id)).collect()
    }

    /// Scans every folder, builds the enabled ones, then follows changes on disk.
    pub async fn start(self: &Arc<Self>) {
        let workspace = self.workspace.clone();
        let folders = blocking(move || workspace.list()).await.unwrap_or_default();
        let flights: Vec<_> = folders.iter().map(|folder| self.begin_refresh(&folder.id)).collect();
        for mut flight in flights {
            let _ = flight.wait_for(|done| *done).await;
        }

        let service: Weak<Self> = Arc::downgrade(self);
        let runtime = Handle::current();
        let watching = self.workspace.watch(Arc::new(move |id: &str| {
            if let Some(service) = service.upgrade() {
                service.schedule(id, &runtime);
            }
        }));
        match watching {
            Ok(guard) => self.lock().watch = Some(guard),
            // Plugins still load and switch; only edits made from now on need a restart to show.
            Err(e) => tracing::error!(error = %e, "the plugins folder cannot be watched"),
        }
    }

    pub fn stop(&self) {
        let (watch, timers) = {
            let mut state = self.lock();
            (state.watch.take(), std::mem::take(&mut state.timers))
        };
        drop(watch);
        for (_, timer) in timers.into_values() {
            timer.abort();
        }
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        let ids: Vec<String> = self.lock().entries.keys().cloned().collect();
        ids.iter().filter_map(|id| self.find(id)).collect()
    }

    pub fn get(&self, id: &str) -> Result<PluginInfo, Error> {
        self.find(id).ok_or_else(|| Error::not_found("plugin", id))
    }

    fn find(&self, id: &str) -> Option<PluginInfo> {
        let (dir, manifest, error, rev, has_build, has_css) = {
            let state = self.lock();
            let entry = state.entries.get(id)?;
            (
                entry.dir.clone(),
                entry.manifest.clone(),
                entry.error.clone(),
                entry.rev,
                entry.build.is_some(),
                entry.build.as_ref().is_some_and(|build| build.css.as_ref().is_some_and(|css| !css.is_empty())),
            )
        };
        let enabled = self.enabled_for(id, manifest.as_ref());
        let settings = plugin_setting_values(manifest.as_ref(), &self.data.settings(id));
        Some(PluginInfo {
            id: id.to_owned(),
            builtin: dir.is_none(),
            dir: dir.map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default(),
            manifest,
            enabled,
            state: match (&error, enabled) {
                (Some(_), _) => PluginState::Error,
                (None, true) => PluginState::Active,
                (None, false) => PluginState::Disabled,
            },
            error,
            rev: if enabled { rev } else { 0 },
            has_ui: enabled && has_build,
            has_css: enabled && has_css,
            settings,
        })
    }

    /// The build a window asks for by revision — only the current one is
    /// kept, so a stale revision is gone (the window has a newer one coming).
    pub fn bundle(&self, id: &str, rev: i64) -> Option<Bundle> {
        self.lock().entries.get(id).filter(|entry| entry.rev == rev).and_then(|entry| entry.build.clone())
    }

    /// Re-reads one folder and rebuilds it when enabled; safe to call any
    /// time. Resolves when the run that was current at the call has ended.
    pub async fn refresh(self: &Arc<Self>, id: &str) {
        let mut flight = self.begin_refresh(id);
        let _ = flight.wait_for(|done| *done).await;
    }

    /// Joins the run in progress for `id` (asking for one more after it), or
    /// starts one. The run goes on whether or not the caller waits.
    fn begin_refresh(self: &Arc<Self>, id: &str) -> watch::Receiver<bool> {
        let (first, running) = {
            let mut state = self.lock();
            if let Some(running) = state.running.get(id) {
                let running = running.clone();
                state.again.insert(id.to_owned());
                return running;
            }
            let (done, running) = watch::channel(false);
            state.running.insert(id.to_owned(), running.clone());
            (done, running)
        };
        self.touch();
        let (service, id) = (self.clone(), id.to_owned());
        tokio::spawn(async move {
            let mut done = Some(first);
            while let Some(signal) = done.take() {
                let mut flight = Flight { service: &service, id: &id, done: Some(signal) };
                service.reload(&id).await;
                done = flight.end();
            }
        });
        running
    }

    pub async fn set_enabled(self: &Arc<Self>, id: &str, on: bool) -> Result<PluginInfo, Error> {
        self.get(id)?;
        self.data.set_enabled(id, on)?;
        self.refresh(id).await;
        self.get(id)
    }

    pub fn set_settings(&self, id: &str, values: &IndexMap<String, PluginSettingValue>) -> Result<PluginInfo, Error> {
        let manifest = match self.lock().entries.get(id) {
            Some(entry) => entry.manifest.clone(),
            None => return Err(Error::not_found("plugin", id)),
        };
        let declared = manifest.as_ref().and_then(|m| m.settings.as_ref());
        if let Some(unknown) = values.keys().find(|key| !declared.is_some_and(|defs| defs.contains_key(*key))) {
            return Err(Error::Validation(format!("plugin \"{id}\" has no setting \"{unknown}\"")));
        }
        let mut merged = self.data.settings(id);
        for (key, value) in values {
            merged.insert(key.clone(), serde_json::to_value(value).map_err(Error::storage)?);
        }
        let kept: Map<String, Value> = plugin_setting_values(manifest.as_ref(), &merged)
            .into_iter()
            .map(|(key, value)| Ok((key, serde_json::to_value(value).map_err(Error::storage)?)))
            .collect::<Result<_, Error>>()?;
        self.data.set_settings(id, &kept)?;
        self.announce(id);
        self.get(id)
    }

    /// A window loaded a build, or it failed / crashed there.
    pub fn report(&self, id: &str, report: PluginReportRequest) -> Result<(), Error> {
        self.get(id)?;
        let at = self.clock.now_ms();
        {
            let mut state = self.lock();
            if let Some(prev) = state.reports.get(id) {
                // A late "loaded" for an old build doesn't hide a newer report.
                if prev.rev > report.rev {
                    return Ok(());
                }
                // A crash after the build loaded stays the news until a newer build loads.
                if prev.rev == report.rev && !prev.ok && report.ok {
                    return Ok(());
                }
            }
            let report = PluginReport { rev: report.rev, ok: report.ok, error: report.error, at: at.into() };
            state.reports.insert(id.to_owned(), report);
        }
        self.touch();
        Ok(())
    }

    pub fn last_report(&self, id: &str) -> Option<PluginReport> {
        self.lock().reports.get(id).cloned()
    }

    /// A rebuild is waiting or running.
    pub fn is_busy(&self, id: &str) -> bool {
        let state = self.lock();
        state.timers.contains_key(id) || state.running.contains_key(id)
    }

    pub fn store_value(&self, id: &str, key: &str) -> Result<Option<Value>, Error> {
        self.get(id)?;
        Ok(self.data.store_value(id, key))
    }

    pub fn set_store_value(&self, id: &str, key: &str, value: Option<Value>) -> Result<(), Error> {
        self.get(id)?;
        self.data.set_store_value(id, key, value)?;
        match serde_json::to_vec(&StoreChange { key }) {
            Ok(payload) => self.bus.publish_raw(plugin_store_topic(id), None, payload.into()),
            Err(e) => tracing::error!(plugin = id, error = %e, "a stored-value event could not be written"),
        }
        Ok(())
    }

    /// One plugin with the windows' latest report. `wait` first lets a
    /// pending rebuild finish and a window load it — for an agent that just
    /// wrote the files.
    pub async fn status(&self, id: &str, wait: bool) -> Result<PluginStatus, Error> {
        if wait {
            self.settled(id).await;
        }
        Ok(PluginStatus { plugin: self.get(id)?, report: self.last_report(id), busy: self.is_busy(id) })
    }

    /// Resolves once the folder has been seen, no rebuild is pending and a
    /// window has reported on the current build (or there is nothing to
    /// load) — or after the settle timeout.
    pub async fn settled(&self, id: &str) {
        let mut moved = self.moved.subscribe();
        let quiet = async {
            loop {
                let seen = self.find(id).is_some_and(|info| {
                    !self.is_busy(id) && (!info.has_ui || self.last_report(id).is_some_and(|r| r.rev == info.rev))
                });
                if seen || moved.changed().await.is_err() {
                    return;
                }
            }
        };
        let _ = tokio::time::timeout(self.options.settle_timeout, quiet).await;
    }

    /// A folder changed: rebuild it once it has been quiet for the debounce window.
    fn schedule(self: &Arc<Self>, id: &str, runtime: &Handle) {
        let mut state = self.lock();
        if let Some((_, previous)) = state.timers.remove(id) {
            previous.abort();
        }
        state.next_timer += 1;
        let number = state.next_timer;
        let (service, key) = (self.clone(), id.to_owned());
        let timer = runtime.spawn(async move {
            tokio::time::sleep(service.options.debounce).await;
            {
                let mut state = service.lock();
                // A newer change has its own timer: this one is done.
                if state.timers.get(&key).is_none_or(|(current, _)| *current != number) {
                    return;
                }
                state.timers.remove(&key);
            }
            service.refresh(&key).await;
        });
        state.timers.insert(id.to_owned(), (number, timer.abort_handle()));
        drop(state);
        self.touch();
    }

    async fn reload(&self, id: &str) {
        if self.is_builtin(id) {
            self.announce(id);
            return;
        }
        let (workspace, key) = (self.workspace.clone(), id.to_owned());
        let Some(folder) = blocking(move || workspace.read(&key)).await.ok().flatten() else {
            let removed = {
                let mut state = self.lock();
                state.reports.remove(id);
                state.entries.remove(id).is_some()
            };
            if removed {
                self.announce(id);
            }
            return;
        };

        let parsed = if id.starts_with(BUILTIN_PLUGIN_PREFIX) {
            Err(format!(
                "the id \"{id}\" is reserved for Eos's built-in plugins — rename the folder (and the manifest id)"
            ))
        } else {
            parse_plugin_manifest(folder.manifest_text.as_deref(), Some(&folder.id))
        };
        // What to build, when the plugin is on and has a UI entry.
        let mut entry_file = None;
        let (manifest, error, has_entry) = match parsed {
            Err(why) => (None, Some(why), true),
            Ok(manifest) => {
                let ui = plugin_ui_entry(&manifest, &folder.files);
                let has_entry = ui.is_some();
                if self.enabled_for(id, Some(&manifest)) {
                    entry_file = ui;
                }
                (Some(manifest), None, has_entry)
            }
        };
        {
            let mut state = self.lock();
            let previous = state.entries.remove(id);
            // The last good build stays until a newer one replaces it — unless there is nothing to build any more.
            let (build, rev) = match previous {
                Some(previous) if has_entry => (previous.build, previous.rev),
                _ => (None, 0),
            };
            state.entries.insert(id.to_owned(), Entry { dir: Some(folder.dir.clone()), manifest, error, build, rev });
        }
        let Some(entry_file) = entry_file else {
            self.announce(id);
            return;
        };

        let built = self.builder.build(&folder.dir, &entry_file).await;
        {
            let mut state = self.lock();
            match built {
                Ok(build) => {
                    let rev = state.next_rev;
                    state.next_rev += 1;
                    if let Some(entry) = state.entries.get_mut(id) {
                        entry.build = Some(Bundle { js: Bytes::from(build.js), css: build.css.map(Bytes::from) });
                        entry.rev = rev;
                    }
                }
                Err(e) => {
                    let why = e.to_string();
                    tracing::warn!(plugin = id, error = %why, "plugin build failed");
                    if let Some(entry) = state.entries.get_mut(id) {
                        entry.error = Some(why);
                    }
                }
            }
        }
        self.announce(id);
    }
}
