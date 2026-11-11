//! Plugins on disk, and where they come from.
//!
//! ```text
//! <home>/plugins/<id>/            a plugin's folder      FsPluginWorkspace (+ its watcher)
//! <home>/plugins/.staging/<id>/   an install in review   FsPluginStaging
//! <home>/plugins/.trash/…         replaced / removed     FsPluginStaging
//! <home>/plugin-data/…            switches, settings,    FsPluginDataStore
//!                                 stored values,
//!                                 installed.json         FsPluginInstallStore
//! ```
//!
//! [`PluginFetchers`] brings a plugin's files from npm, a git repository or a
//! folder into a staging folder. Nothing it fetches is ever run: an npm
//! tarball is checked against the registry's hash and unpacked by hand
//! ([`extract_tar_gz`]), a clone runs no hook, a folder is copied.
//!
//! [`authoring_plugin`] finds the skill folder that teaches agents to write plugins.

mod authoring;
mod data;
mod fetch;
mod preview;
mod staging;
mod tarball;
mod workspace;

pub use authoring::{AUTHORING_PLUGIN_DIR, authoring_plugin};
pub use data::{FsPluginDataStore, FsPluginInstallStore};
pub use fetch::{GitCloner, GuardedHttp, HttpFailure, NPM_REGISTRY, PluginFetchers, RegistryHttp};
pub use preview::TempPreviewFiles;
pub use staging::FsPluginStaging;
pub use tarball::{BadPackage, PACKAGE_LIMITS, PackageLimits, extract_tar_gz, safe_join};
pub use workspace::FsPluginWorkspace;
