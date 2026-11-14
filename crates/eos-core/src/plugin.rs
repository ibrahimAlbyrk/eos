//! Ports of the plugin system: where plugin folders live, how a UI entry is
//! built, where a plugin's switches, settings and stored values are kept, where
//! an install is fetched from and waits for review, and who draws a preview.
//!
//! [`Plugins`] is the other direction: what the rest of the app (the agent
//! tools, session start) may ask the plugin feature.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_contracts::{
    PluginInfo, PluginInstallRecord, PluginPreviewAvailable, PluginPreviewRequest, PluginPreviewResult,
    PluginPreviewSurface, PluginReport, PluginSource,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{BoxFuture, Error};

// ---- plugin folders -------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginFolder {
    /// The folder's name: a plugin's manifest id must match it.
    pub id: String,
    pub dir: PathBuf,
    /// `plugin.json`'s text, or `None` when the folder has none.
    pub manifest_text: Option<String>,
    /// Top-level file names, for finding the default UI entry.
    pub files: Vec<String>,
}

/// Called with the id of a plugin folder that changed (added, edited, removed).
pub type OnPluginChange = Arc<dyn Fn(&str) + Send + Sync>;

/// Dropping it stops the watch.
pub type WatchGuard = Box<dyn Send + Sync>;

pub trait PluginWorkspace: Send + Sync + 'static {
    /// The folder plugin folders live in.
    fn root(&self) -> &Path;
    fn list(&self) -> Vec<PluginFolder>;
    fn read(&self, id: &str) -> Option<PluginFolder>;
    fn watch(&self, on_change: OnPluginChange) -> Result<WatchGuard, Error>;
}

// ---- builds ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginBuild {
    pub js: String,
    pub css: Option<String>,
}

pub trait PluginBuilder: Send + Sync + 'static {
    /// Builds `entry` (relative to `dir`) into one module. A failure's
    /// message is meant for whoever wrote the plugin.
    fn build<'a>(&'a self, dir: &'a Path, entry: &'a str) -> BoxFuture<'a, Result<PluginBuild, Error>>;
}

// ---- switches, settings, stored values ------------------------------------

/// Kept apart from a plugin's source folder: rewriting the folder never
/// touches them.
pub trait PluginDataStore: Send + Sync + 'static {
    /// The saved switch of a plugin; `None` when the user never set it.
    fn enabled(&self, id: &str) -> Option<bool>;
    fn set_enabled(&self, id: &str, on: bool) -> Result<(), Error>;
    fn settings(&self, id: &str) -> Map<String, Value>;
    fn set_settings(&self, id: &str, values: &Map<String, Value>) -> Result<(), Error>;
    fn store_value(&self, id: &str, key: &str) -> Option<Value>;
    /// `None` removes the key.
    fn set_store_value(&self, id: &str, key: &str, value: Option<Value>) -> Result<(), Error>;
}

// ---- installing -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedPlugin {
    /// The tarball URL (npm), the commit (git) or the folder (local).
    pub resolved: String,
    pub integrity: Option<String>,
}

pub trait PluginFetcher: Send + Sync + 'static {
    /// Puts the plugin's files into `dir` (an empty folder) without running
    /// any of them. A failure's message is meant for the user.
    fn fetch<'a>(&'a self, source: &'a PluginSource, dir: &'a Path) -> BoxFuture<'a, Result<FetchedPlugin, Error>>;
}

/// A shallow copy of a git repository, for the git source of an install.
/// Narrow on purpose: the general git ports do not offer a clone.
pub trait PluginCloner: Send + Sync + 'static {
    /// Clones `url` (at a branch or tag when `reference` names one) into
    /// `dir`, an empty folder, without running anything from it: no hooks, no
    /// submodules, links written as plain files. Leaves the files without the
    /// repository's own folder and returns the commit they are from.
    fn shallow_clone<'a>(
        &'a self,
        url: &'a str,
        reference: Option<&'a str>,
        dir: &'a Path,
    ) -> BoxFuture<'a, Result<String, Error>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedFolder {
    pub manifest_text: Option<String>,
    /// Top-level file names, for finding the default UI entry.
    pub top_files: Vec<String>,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewStage {
    pub id: String,
    pub dir: PathBuf,
}

/// Where an install waits for review, and how it moves in. Every call may
/// block on the disk.
pub trait PluginStaging: Send + Sync + 'static {
    /// A new, empty folder for one install.
    fn create(&self) -> Result<NewStage, Error>;
    fn dir(&self, id: &str) -> Option<PathBuf>;
    fn inspect(&self, id: &str) -> Result<StagedFolder, Error>;
    fn discard(&self, id: &str);
    /// Drops every staged install (left over from before a restart).
    fn clear(&self);
    /// Moves a staged folder in as plugin `plugin_id`, all or nothing; the
    /// plugin already there (if any) goes to the trash.
    fn promote(&self, id: &str, plugin_id: &str) -> Result<(), Error>;
    /// Moves plugin `plugin_id`'s folder to the trash.
    fn trash(&self, plugin_id: &str) -> Result<(), Error>;
    /// A plugin folder exists for this id.
    fn has(&self, plugin_id: &str) -> bool;
}

/// Where each installed plugin came from.
pub trait PluginInstallStore: Send + Sync + 'static {
    fn all(&self) -> IndexMap<String, PluginInstallRecord>;
    fn get(&self, id: &str) -> Option<PluginInstallRecord>;
    fn set(&self, id: &str, record: &PluginInstallRecord) -> Result<(), Error>;
    fn remove(&self, id: &str) -> Result<(), Error>;
}

// ---- previews -------------------------------------------------------------

/// What the window shell is asked to draw: the request plus the plugin as it
/// stands (its build revision is what gets loaded).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginPreviewCall {
    #[serde(flatten)]
    pub request: PluginPreviewRequest,
    pub plugin: PluginInfo,
}

/// The window shell, which draws one surface of a plugin in a hidden window.
pub trait PluginPreviewer: Send + Sync + 'static {
    /// False while there is no window shell to draw with.
    fn is_available(&self) -> bool;
    fn preview(&self, call: PluginPreviewCall) -> BoxFuture<'_, Result<PluginPreviewResult, Error>>;
}

/// Where a drawn preview is put for the agent to read (agents get text, so
/// the picture travels as a file path).
pub trait PluginPreviewFiles: Send + Sync + 'static {
    /// Writes `png` to a new file whose name starts with `stem`; returns its path.
    fn save(&self, stem: &str, png: &[u8]) -> Result<PathBuf, Error>;
}

// ---- what the rest of the app asks ----------------------------------------

/// One plugin with what the open windows last said about its build.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginStatus {
    pub plugin: PluginInfo,
    pub report: Option<PluginReport>,
    /// A rebuild is waiting or running.
    pub busy: bool,
}

/// A drawn preview: where the picture is, and what was drawn.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginPreviewed {
    pub path: String,
    /// The build revision that was drawn.
    pub build: i64,
    pub surface: PluginPreviewSurface,
    pub view: Option<String>,
    pub width: eos_contracts::Num,
    pub height: eos_contracts::Num,
    pub errors: Vec<String>,
    pub available: PluginPreviewAvailable,
}

/// The plugin feature, as the agent tools (`plugin_status`, `plugin_preview`)
/// and session start see it.
pub trait Plugins: Send + Sync + 'static {
    /// The folder plugin folders live in.
    fn dir(&self) -> String;
    /// Every plugin, by id.
    fn list(&self) -> Vec<PluginInfo>;
    /// One plugin; `wait` first lets a pending rebuild finish and a window
    /// load it (at most five seconds) — for an agent that just wrote the files.
    fn status<'a>(&'a self, id: &'a str, wait: bool) -> BoxFuture<'a, Result<PluginStatus, Error>>;
    /// A picture of one surface of the plugin's current build.
    fn preview<'a>(
        &'a self,
        id: &'a str,
        request: PluginPreviewRequest,
    ) -> BoxFuture<'a, Result<PluginPreviewed, Error>>;
    fn is_enabled(&self, id: &str) -> bool;
    /// The built-ins switched off, for sessions starting now: their agent
    /// tools and prompt sections are left out.
    fn disabled_builtins(&self) -> Vec<String>;
    /// The Claude Code plugin folder that teaches agents to write Eos plugins
    /// (the `eos-plugin-authoring` skill): every agent session loads it.
    /// `None` when this build ships none.
    fn authoring_plugin(&self) -> Option<PathBuf>;
}
