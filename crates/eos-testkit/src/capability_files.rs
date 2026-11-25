//! Capability packages in a folder of the test's, without hashing.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::capability::CapabilityFiles;
use eos_core::os::FileSystem;
use eos_core::{BoxFuture, Error};

type Key = (String, String);

/// Installs a package by copying it to `<root>/<id>/<version>/` and keeps
/// the hash it was given as the package's own; removes through the files
/// port's trash (a [`FakeTrash`](crate::FakeTrash)). [`tamper`](Self::tamper)
/// stands in for someone editing an installed package.
pub struct FakeCapabilityFiles {
    root: PathBuf,
    trash: Arc<dyn FileSystem>,
    hashes: Mutex<HashMap<Key, String>>,
    stamps: Mutex<HashMap<Key, u32>>,
    sweeps: Mutex<usize>,
}

impl std::fmt::Debug for FakeCapabilityFiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeCapabilityFiles").field("root", &self.root).finish_non_exhaustive()
    }
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn key(id: &str, version: &str) -> Key {
    (id.to_owned(), version.to_owned())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

impl FakeCapabilityFiles {
    pub fn new(root: impl Into<PathBuf>, trash: Arc<dyn FileSystem>) -> Self {
        Self { root: root.into(), trash, hashes: Mutex::default(), stamps: Mutex::default(), sweeps: Mutex::default() }
    }

    pub fn dir(&self, id: &str, version: &str) -> PathBuf {
        self.root.join(id).join(version)
    }

    /// The installed package now hashes to `hash`, and its stamp changed.
    pub fn tamper(&self, id: &str, version: &str, hash: &str) {
        locked(&self.hashes).insert(key(id, version), hash.to_owned());
        *locked(&self.stamps).entry(key(id, version)).or_default() += 1;
    }

    /// How often the start sweep ran.
    pub fn sweeps(&self) -> usize {
        *locked(&self.sweeps)
    }

    fn installed(&self, id: &str, version: &str) -> Result<PathBuf, Error> {
        let dir = self.dir(id, version);
        if dir.is_dir() { Ok(dir) } else { Err(Error::not_found("capability version", format!("{id}@{version}"))) }
    }
}

impl CapabilityFiles for FakeCapabilityFiles {
    fn install<'a>(
        &'a self,
        package_dir: &'a Path,
        id: &'a str,
        version: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        let installed = if self.dir(id, version).exists() {
            Err(Error::Conflict(format!("capability {id} has version {version} already")))
        } else {
            copy_dir(package_dir, &self.dir(id, version)).map_err(Error::storage).map(|()| {
                locked(&self.hashes).insert(key(id, version), hash.to_owned());
            })
        };
        Box::pin(std::future::ready(installed))
    }

    fn install_files<'a>(
        &'a self,
        files: Vec<(String, Vec<u8>)>,
        id: &'a str,
        version: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        let dir = self.dir(id, version);
        let installed = if dir.exists() {
            Err(Error::Conflict(format!("capability {id} has version {version} already")))
        } else {
            files
                .iter()
                .try_for_each(|(relative, bytes)| {
                    let target = dir.join(relative);
                    fs::create_dir_all(target.parent().unwrap_or(&dir))?;
                    fs::write(target, bytes)
                })
                .map_err(Error::storage)
                .map(|()| {
                    locked(&self.hashes).insert(key(id, version), hash.to_owned());
                })
        };
        Box::pin(std::future::ready(installed))
    }

    fn package<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<Vec<(String, Vec<u8>)>, Error>> {
        fn read(dir: &Path, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) -> std::io::Result<()> {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                if entry.file_type()?.is_dir() {
                    read(&entry.path(), &relative, out)?;
                } else {
                    out.push((relative, fs::read(entry.path())?));
                }
            }
            Ok(())
        }
        let files = self.installed(id, version).and_then(|dir| {
            let mut out = Vec::new();
            read(&dir, "", &mut out).map_err(Error::storage)?;
            out.sort();
            Ok(out)
        });
        Box::pin(std::future::ready(files))
    }

    fn remove<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let dir = self.installed(id, version)?;
            self.trash.trash(&dir).await
        })
    }

    fn hash<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        let hash = self
            .installed(id, version)
            .map(|_| locked(&self.hashes).get(&key(id, version)).cloned().unwrap_or_default());
        Box::pin(std::future::ready(hash))
    }

    fn stamp<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        let stamp = self.installed(id, version).map(|_| {
            let n = locked(&self.stamps).get(&key(id, version)).copied().unwrap_or_default();
            format!("stamp-{n}")
        });
        Box::pin(std::future::ready(stamp))
    }

    fn read_text<'a>(&'a self, id: &'a str, version: &'a str, file: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        let text =
            self.installed(id, version).and_then(|dir| fs::read_to_string(dir.join(file)).map_err(Error::storage));
        Box::pin(std::future::ready(text))
    }

    fn sweep(&self) -> BoxFuture<'_, Result<usize, Error>> {
        *locked(&self.sweeps) += 1;
        Box::pin(std::future::ready(Ok(0)))
    }
}
