//! The plugin system over its adapters: plugin folders and their data under
//! the data folder, builds by the shipped esbuild, installs from npm, git or
//! a folder.

use std::path::Path;
use std::sync::Arc;

use eos_core::plugin::PluginPreviewer;
use eos_core::{Clock, Ids};
use eos_git::PluginClones;
use eos_kit_net::SafeFetcher;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_plugins::{PluginHost, PluginHostDeps, PluginServiceOptions};
use eos_platform::DataPaths;
use eos_plugin_build::{EsbuildPluginBuilder, dev_checkout, locate};
use eos_plugin_files::{
    FsPluginDataStore, FsPluginInstallStore, FsPluginStaging, FsPluginWorkspace, GuardedHttp, NPM_REGISTRY,
    PluginFetchers, TempPreviewFiles, authoring_plugin,
};
use eos_runtime::bus::Bus;

use crate::Error;

pub(crate) struct Parts<'a> {
    pub(crate) paths: &'a DataPaths,
    pub(crate) bus: Bus,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) resources: Option<&'a Path>,
    pub(crate) previewer: Arc<dyn PluginPreviewer>,
}

pub(crate) fn host(parts: Parts<'_>) -> Result<Arc<PluginHost>, Error> {
    let dir = parts.paths.join("plugins");
    let data = parts.paths.join("plugin-data");
    let processes = Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    }));
    let checkout = dev_checkout();
    let esbuild = locate(parts.resources.map(|dir| dir.join("esbuild")).as_deref(), checkout.as_deref());
    if esbuild.is_none() {
        tracing::warn!("no esbuild binary: plugins with a UI will not build");
    }
    let registry = GuardedHttp(SafeFetcher::new().map_err(eos_core::Error::storage)?);
    Ok(PluginHost::new(PluginHostDeps {
        workspace: Arc::new(FsPluginWorkspace::new(&dir)),
        builder: Arc::new(EsbuildPluginBuilder::new(processes, esbuild)),
        data: Arc::new(FsPluginDataStore::new(&data)),
        fetcher: Arc::new(PluginFetchers::new(
            Arc::new(registry),
            NPM_REGISTRY,
            Arc::new(PluginClones::new(crate::files::git(&parts.clock))),
        )),
        staging: Arc::new(FsPluginStaging::new(&dir, parts.ids, parts.clock.clone())),
        records: Arc::new(FsPluginInstallStore::new(&data)),
        previewer: parts.previewer,
        preview_files: Arc::new(TempPreviewFiles),
        clock: parts.clock,
        bus: parts.bus,
        builtins: eos_contracts::builtin_plugin_manifests(),
        authoring_plugin: authoring_plugin(parts.resources, checkout.as_deref()),
        options: PluginServiceOptions::default(),
    }))
}
