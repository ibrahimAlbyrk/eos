//! Plugins: a folder `<home>/plugins/<id>/` holding a `plugin.json` manifest
//! and, optionally, a UI entry whose default export activates it in the
//! dashboard. Eos builds the entry itself and reloads it the moment a file
//! changes — no restart. Features that ship with Eos switch on and off the
//! same way (built-in plugins).
//!
//! ```text
//! let host = PluginHost::new(deps);                       // before the runtime is built
//! let runtime = Runtime::build(kernel, modules, host.switch())?;   // host.module() among them
//! runtime.lifecycle.defer("plugins", || host.start())?;   // scan and build off the start-up path
//! ```
//!
//! - [`PluginService`]: the one owner of plugin state — folders, builds,
//!   switches, settings, stored values, what the windows report.
//! - [`PluginInstaller`]: staging and installing a plugin from npm, git or a
//!   folder. The user only: no agent tool reaches its routes.
//! - [`PluginHost`]: both, plus the previews, as the app composes them; it is
//!   the app's [`PluginSwitch`] and other features' [`Plugins`].

mod installer;
mod manifest;
mod preview;
mod routes;
mod service;

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::{PluginInfo, PluginManifest, PluginPreviewRequest};
use eos_core::plugin::{
    PluginBuilder, PluginDataStore, PluginFetcher, PluginInstallStore, PluginPreviewFiles, PluginPreviewed,
    PluginPreviewer, PluginStaging, PluginStatus, PluginWorkspace, Plugins,
};
use eos_core::{BoxFuture, Clock, Error};
use eos_runtime::bus::{Bus, TopicDecl};
use eos_runtime::module::Module;
use eos_runtime::router::{PluginSwitch, RouteDef};

pub use installer::{PluginInstaller, PluginInstallerDeps};
pub use manifest::{parse_plugin_manifest, plugin_ui_entry};
pub use preview::{NoPreviewWindow, PluginPreviews, PreviewFailure};
pub use service::{Bundle, PLUGINS_CHANGE, PluginChange, PluginService, PluginServiceDeps, PluginServiceOptions};

/// Everything outside the process the plugin system uses.
pub struct PluginHostDeps {
    pub workspace: Arc<dyn PluginWorkspace>,
    pub builder: Arc<dyn PluginBuilder>,
    pub data: Arc<dyn PluginDataStore>,
    pub fetcher: Arc<dyn PluginFetcher>,
    pub staging: Arc<dyn PluginStaging>,
    pub records: Arc<dyn PluginInstallStore>,
    pub previewer: Arc<dyn PluginPreviewer>,
    pub preview_files: Arc<dyn PluginPreviewFiles>,
    pub clock: Arc<dyn Clock>,
    pub bus: Bus,
    /// The built-in plugins (`eos_contracts::builtin_plugin_manifests()` in the app).
    pub builtins: Vec<PluginManifest>,
    /// The Claude Code plugin folder that teaches agents to write Eos
    /// plugins (the `eos-plugin-authoring` skill), when the app ships one.
    pub authoring_plugin: Option<PathBuf>,
    pub options: PluginServiceOptions,
}

impl std::fmt::Debug for PluginHostDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginHostDeps").field("options", &self.options).finish_non_exhaustive()
    }
}

/// The plugin system as the app composes it.
#[derive(Debug)]
pub struct PluginHost {
    pub plugins: Arc<PluginService>,
    pub installer: Arc<PluginInstaller>,
    previews: Arc<PluginPreviews>,
    authoring_plugin: Option<PathBuf>,
}

impl PluginHost {
    pub fn new(deps: PluginHostDeps) -> Arc<Self> {
        let plugins = PluginService::new(PluginServiceDeps {
            workspace: deps.workspace,
            builder: deps.builder.clone(),
            data: deps.data,
            clock: deps.clock.clone(),
            bus: deps.bus,
            builtins: deps.builtins,
            options: deps.options,
        });
        let installer = PluginInstaller::new(PluginInstallerDeps {
            fetcher: deps.fetcher,
            staging: deps.staging,
            records: deps.records,
            builder: deps.builder,
            plugins: plugins.clone(),
            clock: deps.clock.clone(),
        });
        let previews = Arc::new(PluginPreviews::new(plugins.clone(), deps.previewer, deps.preview_files, deps.clock));
        Arc::new(Self { plugins, installer, previews, authoring_plugin: deps.authoring_plugin })
    }

    /// Drops installs left staged by the last run, builds every plugin and
    /// follows changes on disk. Routes answer before this has finished: the
    /// list fills in, each plugin announcing itself.
    pub async fn start(&self) {
        self.installer.start().await;
        self.plugins.start().await;
    }

    /// The switch the router and the agent-event fan-out ask about built-ins.
    pub fn switch(self: &Arc<Self>) -> Arc<dyn PluginSwitch> {
        self.clone()
    }

    /// The module that carries the plugin routes.
    pub fn module(self: &Arc<Self>) -> Arc<dyn Module> {
        Arc::new(PluginsModule { host: self.clone() })
    }
}

impl PluginSwitch for PluginHost {
    fn is_on(&self, plugin: &str) -> bool {
        self.plugins.is_feature_on(plugin)
    }

    fn name(&self, plugin: &str) -> String {
        self.plugins.builtin_name(plugin).unwrap_or(plugin).to_owned()
    }
}

impl Plugins for PluginHost {
    fn dir(&self) -> String {
        self.plugins.dir()
    }

    fn list(&self) -> Vec<PluginInfo> {
        self.plugins.list()
    }

    fn status<'a>(&'a self, id: &'a str, wait: bool) -> BoxFuture<'a, Result<PluginStatus, Error>> {
        Box::pin(self.plugins.status(id, wait))
    }

    fn preview<'a>(
        &'a self,
        id: &'a str,
        request: PluginPreviewRequest,
    ) -> BoxFuture<'a, Result<PluginPreviewed, Error>> {
        Box::pin(async move { Ok(self.previews.draw(id, request).await?) })
    }

    fn is_enabled(&self, id: &str) -> bool {
        self.plugins.is_enabled(id)
    }

    fn disabled_builtins(&self) -> Vec<String> {
        self.plugins.disabled_builtins()
    }

    fn authoring_plugin(&self) -> Option<PathBuf> {
        self.authoring_plugin.clone()
    }
}

struct PluginsModule {
    host: Arc<PluginHost>,
}

impl Module for PluginsModule {
    fn id(&self) -> &'static str {
        "plugins"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&routes::Deps {
            plugins: self.host.plugins.clone(),
            installer: self.host.installer.clone(),
            previews: self.host.previews.clone(),
        })
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![PLUGINS_CHANGE.decl()]
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.host.plugins.stop();
        Box::pin(std::future::ready(()))
    }
}
