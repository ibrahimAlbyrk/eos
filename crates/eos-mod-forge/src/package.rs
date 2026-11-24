//! The package a Forge run built, as Eos reads it from the build folder,
//! and the reports the run keeps as its events.

use std::path::{Component, Path, PathBuf};

use eos_contracts::ForgeBuild;
use eos_core::Error;
use eos_core::store::Store;
use eos_domain::capability::check::check;
use eos_domain::capability::manifest::{Manifest, parse};
use serde::de::DeserializeOwned;

use crate::steps::ForgeSteps;

/// The package in the build folder, read: where it is, its manifest, and
/// the hash and size of its files now.
#[derive(Debug, Clone)]
pub(crate) struct Built {
    pub(crate) dir: PathBuf,
    pub(crate) manifest: Manifest,
    pub(crate) hash: String,
    pub(crate) size: u64,
}

/// The newest event `kind` of the run, read as `T`.
pub(crate) async fn newest<T: DeserializeOwned>(
    store: &dyn Store,
    run_id: &str,
    kind: &str,
) -> Result<Option<T>, Error> {
    let (id, kind_owned) = (run_id.to_owned(), kind.to_owned());
    let data = store
        .read(move |tx| {
            let events = tx.runs().events(&id)?;
            Ok(events.into_iter().rev().find(|event| event.kind == kind_owned).and_then(|event| event.data))
        })
        .await?;
    data.map(|text| serde_json::from_str(&text).map_err(|e| Error::storage(format!("a Forge event {kind}: {e}"))))
        .transpose()
}

/// Reads the package the builder reported, refusing one that is not a
/// plain folder inside the build folder (no link on the way), whose
/// manifest fails the check, or that names another capability or version
/// than the report.
pub(crate) async fn read(steps: &ForgeSteps, run_id: &str, build: &ForgeBuild) -> Result<Result<Built, String>, Error> {
    let folder = steps.folder(run_id)?;
    let relative = PathBuf::from(&build.package);
    if build.package.is_empty() || !relative.components().all(|part| matches!(part, Component::Normal(_))) {
        return Ok(Err("the builder named a package outside its build folder".into()));
    }
    let dir = folder.join(&relative);
    let (expected_id, expected_version) = (build.capability_id.clone(), build.version.clone());
    let read = tokio::task::spawn_blocking(move || -> Result<Result<Built, String>, Error> {
        if let Err(why) = plain_folders(&folder, &relative) {
            return Ok(Err(why));
        }
        let Ok(text) = std::fs::read_to_string(dir.join("capability.toml")) else {
            return Ok(Err("the package has no capability.toml".into()));
        };
        let manifest = match parse(&text) {
            Ok(manifest) => manifest,
            Err(_) => return Ok(Err("its capability.toml could not be read".into())),
        };
        let issues = check(&manifest);
        if !issues.is_empty() {
            let issues: Vec<String> = issues.iter().map(ToString::to_string).collect();
            return Ok(Err(format!("its manifest fails the check: {}", issues.join("; "))));
        }
        if manifest.reach.files_read.iter().any(|path| !Path::new(path).is_absolute()) {
            return Ok(Err("a file its manifest reads is no absolute path".into()));
        }
        if (manifest.id.as_str(), manifest.version.as_str()) != (expected_id.as_str(), expected_version.as_str()) {
            return Ok(Err("its manifest names another capability or version than the builder's report".into()));
        }
        let (hash, size) = match eos_store_files::capabilities::package_of(&dir) {
            Ok(found) => found,
            Err(Error::Validation(why)) => return Ok(Err(why)),
            Err(error) => return Err(error),
        };
        Ok(Ok(Built { dir, manifest, hash, size }))
    });
    read.await.map_err(Error::storage)?
}

/// Each folder from the build folder down to the package is a folder, not
/// a link that leads out of it.
fn plain_folders(folder: &Path, relative: &Path) -> Result<(), String> {
    let mut at = folder.to_owned();
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            at.push(part);
        }
        match std::fs::symlink_metadata(&at) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err("the package's folder is a link or a file".into()),
            Err(_) => return Err("the package's folder is missing".into()),
        }
    }
    Ok(())
}
