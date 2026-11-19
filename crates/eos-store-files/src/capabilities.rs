//! Capability packages: `<data folder>/capabilities/<id>/<version>/`. A
//! version is copied in beside its final place as `<version>.partial/` and
//! renamed once its hash is the reviewed one, so a version folder is whole
//! or absent. What goes, goes through the files port's trash.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use eos_core::capability::{CapabilityFiles, PACKAGE_MAX_BYTES};
use eos_core::os::FileSystem;
use eos_core::{BoxFuture, Error};
use eos_domain::capability::check::{PARTIAL_SUFFIX, is_version};
use eos_domain::capability::hash::package_hash;

pub struct FsCapabilityFiles {
    root: PathBuf,
    files: Arc<dyn FileSystem>,
}

impl std::fmt::Debug for FsCapabilityFiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FsCapabilityFiles").field("root", &self.root).finish_non_exhaustive()
    }
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |e| Error::Storage(format!("{}: {e}", path.display()))
}

/// Runs disk work off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(work).await.map_err(Error::storage)?
}

/// One name of a path that stays inside its folder.
fn component<'a>(kind: &'static str, name: &'a str) -> Result<&'a str, Error> {
    let plain = !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', '\0']);
    if plain { Ok(name) } else { Err(Error::Validation(format!("not a capability {kind}: {name:?}"))) }
}

/// The files below `dir`, by relative path (`/` between folders), sorted.
/// A link or anything else that is not a file or a folder refuses the
/// package: its code may read only what it holds.
fn walk(dir: &Path) -> Result<Vec<(String, PathBuf)>, Error> {
    fn visit(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), Error> {
        for entry in fs::read_dir(dir).map_err(io(dir))? {
            let entry = entry.map_err(io(dir))?;
            let path = entry.path();
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Error::Validation(format!("a package's file names are UTF-8: {}", path.display())))?;
            let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            let kind = entry.file_type().map_err(io(&path))?;
            if kind.is_dir() {
                visit(&path, &relative, out)?;
            } else if kind.is_file() {
                out.push((relative, path));
            } else {
                return Err(Error::Validation(format!("a package holds only files and folders: {relative}")));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(dir, "", &mut out)?;
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Ok(out)
}

fn hash_dir(dir: &Path) -> Result<String, Error> {
    let mut files = Vec::new();
    for (relative, path) in walk(dir)? {
        files.push((relative, fs::read(&path).map_err(io(&path))?));
    }
    let files: Vec<(&str, &[u8])> =
        files.iter().map(|(relative, bytes)| (relative.as_str(), bytes.as_slice())).collect();
    Ok(package_hash(&files))
}

/// The package hash's format over each file's size and change time in place
/// of its bytes.
fn stamp_dir(dir: &Path) -> Result<String, Error> {
    let mut entries = Vec::new();
    for (relative, path) in walk(dir)? {
        let meta = fs::metadata(&path).map_err(io(&path))?;
        let changed = meta.modified().map_err(io(&path))?.duration_since(UNIX_EPOCH).unwrap_or_default();
        entries.push((relative, format!("{} {}", meta.len(), changed.as_nanos())));
    }
    let entries: Vec<(&str, &[u8])> = entries.iter().map(|(relative, at)| (relative.as_str(), at.as_bytes())).collect();
    Ok(package_hash(&entries))
}

/// Copies the package in `from` to the new folder `to`.
fn copy_in(from: &Path, to: &Path) -> Result<(), Error> {
    let files = walk(from)?;
    let mut bytes = 0;
    for (_, path) in &files {
        bytes += fs::metadata(path).map_err(io(path))?.len();
    }
    if bytes > PACKAGE_MAX_BYTES {
        return Err(Error::LimitExceeded(format!(
            "a capability package is at most {} MiB",
            PACKAGE_MAX_BYTES / 1024 / 1024
        )));
    }
    fs::create_dir_all(to).map_err(io(to))?;
    for (relative, path) in files {
        let target = to.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io(parent))?;
        }
        fs::copy(&path, &target).map_err(io(&path))?;
    }
    Ok(())
}

impl FsCapabilityFiles {
    /// `root`: `<data folder>/capabilities`, made on the first install;
    /// `files` trashes what goes.
    pub fn new(root: impl Into<PathBuf>, files: Arc<dyn FileSystem>) -> Self {
        Self { root: root.into(), files }
    }

    fn version_dir(&self, id: &str, version: &str) -> Result<PathBuf, Error> {
        if !is_version(version) {
            return Err(Error::Validation(format!("not a capability version: {version:?}")));
        }
        Ok(self.root.join(component("id", id)?).join(version))
    }

    fn installed(&self, id: &str, version: &str) -> Result<PathBuf, Error> {
        let dir = self.version_dir(id, version)?;
        if dir.is_dir() { Ok(dir) } else { Err(Error::not_found("capability version", format!("{id}@{version}"))) }
    }

    /// Every `<id>/<version>.partial/` there is.
    fn partials(&self) -> Result<Vec<PathBuf>, Error> {
        let Ok(capabilities) = fs::read_dir(&self.root) else { return Ok(Vec::new()) };
        let mut partials = Vec::new();
        for capability in capabilities.flatten().filter(|entry| entry.path().is_dir()) {
            let dir = capability.path();
            for entry in fs::read_dir(&dir).map_err(io(&dir))?.flatten() {
                if entry.file_name().to_string_lossy().ends_with(PARTIAL_SUFFIX) && entry.path().is_dir() {
                    partials.push(entry.path());
                }
            }
        }
        partials.sort();
        Ok(partials)
    }
}

impl CapabilityFiles for FsCapabilityFiles {
    fn install<'a>(
        &'a self,
        package_dir: &'a Path,
        id: &'a str,
        version: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let target = self.version_dir(id, version)?;
            if target.exists() {
                return Err(Error::Conflict(format!("capability {id} has version {version} already")));
            }
            let partial = target.with_file_name(format!("{version}{PARTIAL_SUFFIX}"));
            if partial.exists() {
                self.files.trash(&partial).await?;
            }
            let copied = {
                let (from, to) = (package_dir.to_owned(), partial.clone());
                blocking(move || copy_in(&from, &to).and_then(|()| hash_dir(&to))).await
            };
            let copied = match copied {
                Ok(copied) => copied,
                Err(e) => {
                    if partial.exists() {
                        // What the trash cannot take now, the start sweep takes.
                        let _left = self.files.trash(&partial).await;
                    }
                    return Err(e);
                }
            };
            if copied != hash {
                self.files.trash(&partial).await?;
                return Err(Error::Rule(format!(
                    "capability {id} {version}: its files are not the ones it was checked with"
                )));
            }
            blocking(move || fs::rename(&partial, &target).map_err(io(&partial))).await
        })
    }

    fn remove<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let dir = self.installed(id, version)?;
            self.files.trash(&dir).await
        })
    }

    fn hash<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let dir = self.installed(id, version)?;
            blocking(move || hash_dir(&dir)).await
        })
    }

    fn stamp<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let dir = self.installed(id, version)?;
            blocking(move || stamp_dir(&dir)).await
        })
    }

    fn sweep(&self) -> BoxFuture<'_, Result<usize, Error>> {
        Box::pin(async move {
            let partials = self.partials()?;
            for partial in &partials {
                self.files.trash(partial).await?;
            }
            Ok(partials.len())
        })
    }
}

#[cfg(test)]
mod tests;
