//! Fetches a plugin's files from where it is published, running none of them:
//!
//! - npm — the registry's tarball, checked against the registry's sha512
//!   integrity hash, unpacked by hand. No `npm install`: no install scripts,
//!   no dependencies — a plugin package carries its own files.
//! - git — a shallow https clone with hooks off and no submodules; the commit
//!   it landed on is what gets recorded.
//! - local — a copy of a folder on this computer (`node_modules`, `.git` and
//!   dot-files left out).

mod git;
mod local;
mod npm;

use std::path::Path;
use std::sync::Arc;

use eos_contracts::PluginSource;
use eos_core::plugin::{FetchedPlugin, PluginCloner, PluginFetcher};
use eos_core::{BoxFuture, Error};

pub use git::GitCloner;
pub use npm::{GuardedHttp, HttpFailure, NPM_REGISTRY, RegistryHttp};

use crate::tarball::{PACKAGE_LIMITS, PackageLimits};

/// Runs disk work off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(work).await.map_err(Error::storage)?
}

/// Fails once a folder holds more than a plugin may: for a source that
/// arrives as a tree (a clone) rather than an archive.
fn check_size(dir: &Path, what: &str, limits: PackageLimits) -> Result<(), Error> {
    fn walk(dir: &Path, files: &mut u64, bytes: &mut u64, limits: PackageLimits) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return true };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.is_dir() {
                if !walk(&entry.path(), files, bytes, limits) {
                    return false;
                }
            } else {
                *files += 1;
                *bytes += meta.len();
            }
            if *files > limits.files || *bytes > limits.bytes {
                return false;
            }
        }
        true
    }
    let (mut files, mut bytes) = (0, 0);
    if walk(dir, &mut files, &mut bytes, limits) {
        Ok(())
    } else {
        Err(Error::Validation(format!("{what} is too big for a plugin")))
    }
}

/// The three sources behind one port.
pub struct PluginFetchers {
    http: Arc<dyn RegistryHttp>,
    registry: String,
    cloner: Arc<dyn PluginCloner>,
    limits: PackageLimits,
}

impl std::fmt::Debug for PluginFetchers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginFetchers").field("registry", &self.registry).finish_non_exhaustive()
    }
}

impl PluginFetchers {
    /// `registry`: the npm registry's base URL ([`NPM_REGISTRY`]).
    pub fn new(http: Arc<dyn RegistryHttp>, registry: impl Into<String>, cloner: Arc<dyn PluginCloner>) -> Self {
        Self { http, registry: registry.into(), cloner, limits: PACKAGE_LIMITS }
    }
}

impl PluginFetcher for PluginFetchers {
    fn fetch<'a>(&'a self, source: &'a PluginSource, dir: &'a Path) -> BoxFuture<'a, Result<FetchedPlugin, Error>> {
        Box::pin(async move {
            match source {
                PluginSource::Npm(npm) => npm::fetch(self.http.as_ref(), &self.registry, npm, dir, self.limits).await,
                PluginSource::Git(git) => {
                    let commit = self.cloner.shallow_clone(&git.url, git.r#ref.as_deref(), dir).await?;
                    let (dir, what, limits) = (dir.to_owned(), git.url.clone(), self.limits);
                    blocking(move || check_size(&dir, &what, limits)).await?;
                    Ok(FetchedPlugin { integrity: Some(format!("git:{commit}")), resolved: commit })
                }
                PluginSource::Local(local) => {
                    let (path, dir, limits) = (local.path.clone(), dir.to_owned(), self.limits);
                    blocking(move || local::copy(&path, &dir, limits)).await
                }
            }
        })
    }
}
