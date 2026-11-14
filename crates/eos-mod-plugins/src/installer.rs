//! `PluginInstaller` — adds a plugin someone else wrote, on the user's
//! say-so. An install is staged first: fetched without running anything, its
//! manifest checked and its UI test-built, then shown for review. Only an
//! approved stage moves into the plugins folder (the plugin it replaces goes
//! to the trash), and where it came from is recorded so it can be updated or
//! removed later.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{
    BUILTIN_PLUGIN_PREFIX, PluginInfo, PluginInstallRecord, PluginManifest, PluginSource, PluginSourceNpm,
    StagedPlugin, StagedPluginReplaces,
};
use eos_core::plugin::{PluginBuilder, PluginFetcher, PluginInstallStore, PluginStaging};
use eos_core::{Clock, Error};
use indexmap::IndexMap;

use crate::manifest::{parse_plugin_manifest, plugin_ui_entry};
use crate::service::PluginService;

/// Stages waiting for review; past this many the oldest is dropped.
const MAX_PENDING: usize = 4;

pub struct PluginInstaller {
    fetcher: Arc<dyn PluginFetcher>,
    staging: Arc<dyn PluginStaging>,
    records: Arc<dyn PluginInstallStore>,
    builder: Arc<dyn PluginBuilder>,
    /// The plugin list, re-read once a folder changes.
    plugins: Arc<PluginService>,
    clock: Arc<dyn Clock>,
    pending: Mutex<IndexMap<String, StagedPlugin>>,
}

impl std::fmt::Debug for PluginInstaller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginInstaller").finish_non_exhaustive()
    }
}

/// What the installer is built from.
pub struct PluginInstallerDeps {
    pub fetcher: Arc<dyn PluginFetcher>,
    pub staging: Arc<dyn PluginStaging>,
    pub records: Arc<dyn PluginInstallStore>,
    pub builder: Arc<dyn PluginBuilder>,
    pub plugins: Arc<PluginService>,
    pub clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for PluginInstallerDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginInstallerDeps").finish_non_exhaustive()
    }
}

/// The staging area works on the disk: off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(work).await.map_err(Error::storage)
}

impl PluginInstaller {
    pub fn new(deps: PluginInstallerDeps) -> Arc<Self> {
        Arc::new(Self {
            fetcher: deps.fetcher,
            staging: deps.staging,
            records: deps.records,
            builder: deps.builder,
            plugins: deps.plugins,
            clock: deps.clock,
            pending: Mutex::new(IndexMap::new()),
        })
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, IndexMap<String, StagedPlugin>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stages left over from before a restart are dropped.
    pub async fn start(&self) {
        let staging = self.staging.clone();
        let _ = blocking(move || staging.clear()).await;
    }

    /// Where each installed plugin came from.
    pub fn installs(&self) -> IndexMap<String, PluginInstallRecord> {
        self.records.all()
    }

    /// Fetches, checks and test-builds a plugin, and keeps it for review.
    /// Runs to its end even when the caller stops waiting, so a stage is
    /// never left half-made.
    pub async fn stage(self: &Arc<Self>, source: PluginSource) -> Result<StagedPlugin, Error> {
        let installer = self.clone();
        tokio::spawn(async move { installer.stage_now(source).await }).await.map_err(Error::storage)?
    }

    async fn stage_now(&self, source: PluginSource) -> Result<StagedPlugin, Error> {
        let staging = self.staging.clone();
        let stage = blocking(move || staging.create()).await??;
        let staged = self.fill(&stage.id, &stage.dir, source).await;
        match staged {
            Ok(staged) => {
                self.remember(staged.clone()).await;
                Ok(staged)
            }
            Err(e) => {
                self.drop_stage(stage.id).await;
                Err(e)
            }
        }
    }

    async fn fill(&self, staging_id: &str, dir: &Path, source: PluginSource) -> Result<StagedPlugin, Error> {
        let fetched = self.fetcher.fetch(&source, dir).await?;
        let (staging, id) = (self.staging.clone(), staging_id.to_owned());
        let folder = blocking(move || staging.inspect(&id)).await??;
        let manifest = parse_plugin_manifest(folder.manifest_text.as_deref(), None)
            .map_err(|why| Error::Validation(format!("not an Eos plugin — {why}")))?;
        let plugin_id = manifest.id.0.clone();
        if plugin_id.starts_with(BUILTIN_PLUGIN_PREFIX) {
            return Err(Error::Validation(format!("the id \"{plugin_id}\" is reserved for Eos's built-in plugins")));
        }
        self.test_build(dir, &manifest, &folder.top_files).await?;
        let record = self.records.get(&plugin_id);
        let replaces = self.staging.has(&plugin_id).then(|| StagedPluginReplaces {
            version: record.as_ref().and_then(|r| r.version.clone()),
            installed: record.is_some(),
        });
        Ok(StagedPlugin {
            staging_id: staging_id.to_owned(),
            manifest,
            source,
            resolved: fetched.resolved,
            integrity: fetched.integrity,
            files: i64::try_from(folder.files).unwrap_or(i64::MAX),
            bytes: i64::try_from(folder.bytes).unwrap_or(i64::MAX),
            replaces,
        })
    }

    /// Stages the newest version from where the plugin was installed from:
    /// the same tag (an exact version follows "latest"), branch or folder.
    pub async fn stage_update(self: &Arc<Self>, id: &str) -> Result<StagedPlugin, Error> {
        let Some(record) = self.records.get(id) else {
            return Err(Error::Validation(format!(
                "\"{id}\" wasn't installed from npm, git or a folder — there's nothing to update it from"
            )));
        };
        let source = match record.source {
            PluginSource::Npm(npm)
                if npm.version.as_deref().is_some_and(|v| v.starts_with(|c: char| c.is_ascii_digit())) =>
            {
                PluginSource::Npm(PluginSourceNpm { name: npm.name, version: None })
            }
            other => other,
        };
        self.stage(source).await
    }

    /// Moves a reviewed stage in as its plugin and records where it came from.
    pub async fn commit(&self, staging_id: &str) -> Result<PluginInfo, Error> {
        let Some(staged) = self.pending().get(staging_id).cloned() else {
            return Err(Error::not_found("staged plugin", staging_id));
        };
        let id = staged.manifest.id.0.clone();
        let (staging, stage, plugin) = (self.staging.clone(), staging_id.to_owned(), id.clone());
        blocking(move || staging.promote(&stage, &plugin)).await??;
        self.pending().shift_remove(staging_id);
        self.records.set(
            &id,
            &PluginInstallRecord {
                source: staged.source,
                resolved: staged.resolved,
                integrity: staged.integrity,
                version: staged.manifest.version,
                installed_at: self.clock.now_ms().into(),
            },
        )?;
        self.plugins.refresh(&id).await;
        self.plugins.get(&id)
    }

    pub async fn discard(&self, staging_id: &str) {
        self.pending().shift_remove(staging_id);
        self.drop_stage(staging_id.to_owned()).await;
    }

    /// Any plugin with a folder — installed or written here — goes to the trash.
    pub async fn remove(&self, id: &str) -> Result<(), Error> {
        let (staging, plugin) = (self.staging.clone(), id.to_owned());
        let trashed =
            blocking(move || if staging.has(&plugin) { staging.trash(&plugin).map(|()| true) } else { Ok(false) });
        if !trashed.await?? {
            return Err(Error::not_found("plugin", id));
        }
        self.records.remove(id)?;
        self.plugins.refresh(id).await;
        Ok(())
    }

    async fn test_build(&self, dir: &Path, manifest: &PluginManifest, top_files: &[String]) -> Result<(), Error> {
        let Some(entry) = plugin_ui_entry(manifest, top_files) else { return Ok(()) };
        self.builder
            .build(dir, &entry)
            .await
            .map(|_| ())
            .map_err(|e| Error::Validation(format!("the plugin doesn't build: {e}")))
    }

    async fn drop_stage(&self, staging_id: String) {
        let staging = self.staging.clone();
        let _ = blocking(move || staging.discard(&staging_id)).await;
    }

    async fn remember(&self, staged: StagedPlugin) {
        let dropped: Vec<String> = {
            let mut pending = self.pending();
            pending.insert(staged.staging_id.clone(), staged);
            let over = pending.len().saturating_sub(MAX_PENDING);
            pending.drain(..over).map(|(id, _)| id).collect()
        };
        for oldest in dropped {
            self.drop_stage(oldest).await;
        }
    }
}
