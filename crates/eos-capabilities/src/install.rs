//! Installing a package version, going back to a kept one, and removing a
//! capability. Files first, row second: a crash in between leaves at most a
//! `.partial` folder, which the start sweep sends to the trash. Removal
//! goes through the trash too, and keeps the capability's secrets.

use std::path::PathBuf;

use eos_core::Error;
use eos_core::capability::INSTALLED_MAX;
use eos_core::store::{StoredCapabilityVersion, StoredInstall, Tx};
use eos_domain::capability::check::check;
use eos_domain::capability::manifest::Manifest;

use crate::CapabilityService;
use crate::health::announce;
use crate::registry::BUILTIN;

/// The status of a version installed on this computer.
const INSTALLED: &str = "installed";

/// A package to install, as its review left it.
#[derive(Debug, Clone)]
pub struct Install {
    /// The folder the package was built or unpacked in.
    pub package_dir: PathBuf,
    /// Its `capability.toml`, read.
    pub manifest: Manifest,
    /// The hash it was reviewed with; the copy must have it.
    pub hash: String,
    /// `forge`, `registry` or `synced`.
    pub origin: String,
    /// A Forge run's id, or a pinned package (`npm:pkg@1.2.3#sha512-…`).
    pub source: String,
}

impl CapabilityService {
    /// Installs the package as its capability's active version and
    /// announces it. A version already known must have the same hash.
    pub async fn install(&self, install: Install) -> Result<(), Error> {
        let Install { package_dir, manifest, hash, origin, source } = install;
        let issues = check(&manifest);
        if !issues.is_empty() {
            let issues: Vec<String> = issues.iter().map(ToString::to_string).collect();
            return Err(Error::Validation(issues.join("; ")));
        }
        let (id, version) = (manifest.id.clone(), manifest.version.clone());
        if self.builtins.contains_key(&id) {
            return Err(Error::Conflict(format!("{id} is a built-in capability")));
        }
        {
            let (id, version, hash) = (id.clone(), version.clone(), hash.clone());
            // Refused before any file is copied; the write checks again.
            self.ports.store.read(move |tx| admit(tx, &id, &version, &hash)).await?;
        }
        self.ports.files.install(&package_dir, &id, &version, &hash).await?;
        let health = self.fresh_health(&manifest).await?;
        let manifest_json = serde_json::to_string(&manifest).map_err(Error::storage)?;
        let now = self.ports.clock.now_ms();
        let row = StoredCapabilityVersion {
            capability_id: id.clone(),
            version: version.clone(),
            status: INSTALLED.to_owned(),
            hash: hash.clone(),
            manifest_json,
            source,
            tests_json: None,
            review_json: None,
            created_at: now,
            activated_at: Some(now),
            retired_at: None,
        };
        let written = self
            .ports
            .store
            .write(move |tx, outbox| {
                if admit(tx, &id, &version, &hash)?.is_none() {
                    tx.capability_versions().insert(&row)?;
                }
                let before = tx.capability_installs().find(&id)?;
                let install = StoredInstall {
                    id: id.clone(),
                    origin: before.as_ref().map_or(origin, |before| before.origin.clone()),
                    active_version: Some(version),
                    health,
                    state_since: now,
                    settings_json: before.as_ref().map_or_else(|| "{}".to_owned(), |b| b.settings_json.clone()),
                    account_label: before.as_ref().and_then(|before| before.account_label.clone()),
                    installed_at: before.as_ref().map_or(now, |before| before.installed_at),
                    updated_at: now,
                };
                tx.capability_installs().put(&install)?;
                announce(outbox, &install);
                Ok(before.and_then(|before| before.active_version))
            })
            .await;
        let replaced = match written {
            Ok(replaced) => replaced,
            Err(e) => {
                // The files were copied by this call alone; without their row they go.
                let _left = self.ports.files.remove(&manifest.id, &manifest.version).await;
                return Err(e);
            }
        };
        if replaced.is_some() {
            self.stop_runs(&manifest.id).await;
        }
        Ok(())
    }

    /// Makes `version`, one kept on this computer, the active one again,
    /// once its files still hash to its pinned hash.
    pub async fn rollback(&self, id: &str, version: &str) -> Result<(), Error> {
        let (install, kept) = {
            let (id, version) = (id.to_owned(), version.to_owned());
            self.ports
                .store
                .read(move |tx| {
                    Ok((tx.capability_installs().find(&id)?, tx.capability_versions().find(&id, &version)?))
                })
                .await?
        };
        let install = install.ok_or_else(|| Error::not_found("capability", id))?;
        if install.origin == BUILTIN {
            return Err(Error::Rule(format!("{id} is a built-in capability: it has no versions")));
        }
        let kept = kept
            .filter(|kept| kept.status == INSTALLED)
            .ok_or_else(|| Error::not_found("capability version", format!("{id}@{version}")))?;
        if install.active_version.as_deref() == Some(version) {
            return Ok(());
        }
        if self.ports.files.hash(id, version).await? != kept.hash {
            return Err(Error::Rule(format!("capability {id} {version}: its files changed since it was installed")));
        }
        let manifest: Manifest = serde_json::from_str(&kept.manifest_json).map_err(Error::storage)?;
        let health = self.fresh_health(&manifest).await?;
        let (id_owned, version_owned, now) = (id.to_owned(), version.to_owned(), self.ports.clock.now_ms());
        self.ports
            .store
            .write(move |tx, outbox| {
                let mut install = tx
                    .capability_installs()
                    .find(&id_owned)?
                    .ok_or_else(|| Error::not_found("capability", &id_owned))?;
                install.active_version = Some(version_owned);
                install.health = health;
                install.state_since = now;
                install.updated_at = now;
                tx.capability_installs().put(&install)?;
                announce(outbox, &install);
                Ok(())
            })
            .await?;
        self.stop_runs(id).await;
        Ok(())
    }

    /// Moves every installed version of the capability to the trash, then
    /// drops its row; its secrets stay. Announced with the state it had and
    /// no version: whoever reads the change finds the capability gone.
    pub async fn remove(&self, id: &str) -> Result<(), Error> {
        let (install, versions) = {
            let id = id.to_owned();
            self.ports
                .store
                .read(move |tx| Ok((tx.capability_installs().find(&id)?, tx.capability_versions().of_capability(&id)?)))
                .await?
        };
        let install = install.ok_or_else(|| Error::not_found("capability", id))?;
        if install.origin == BUILTIN {
            return Err(Error::Rule(format!("{id} is a built-in capability: it cannot be removed")));
        }
        for version in versions.iter().filter(|version| version.status == INSTALLED) {
            match self.ports.files.remove(id, &version.version).await {
                Ok(()) | Err(Error::NotFound { .. }) => {}
                Err(e) => return Err(e),
            }
        }
        self.stop_runs(id).await;
        self.stamps.lock().unwrap_or_else(|p| p.into_inner()).retain(|(capability, _), _| capability != id);
        let id = id.to_owned();
        self.ports
            .store
            .write(move |tx, outbox| {
                let mut install =
                    tx.capability_installs().find(&id)?.ok_or_else(|| Error::not_found("capability", &id))?;
                tx.capability_installs().delete(&id)?;
                install.active_version = None;
                announce(outbox, &install);
                Ok(())
            })
            .await
    }

    /// Lets the runner stop what runs for an older version once its calls end.
    async fn stop_runs(&self, id: &str) {
        if let Some(runner) = &self.ports.runner {
            runner.stop(id).await;
        }
    }
}

/// Refuses a capability past [`INSTALLED_MAX`] or a known version with
/// other files; returns the known version's row.
fn admit(tx: &dyn Tx, id: &str, version: &str, hash: &str) -> Result<Option<StoredCapabilityVersion>, Error> {
    let others =
        tx.capability_installs().list()?.iter().filter(|install| install.origin != BUILTIN && install.id != id).count();
    if others >= INSTALLED_MAX {
        return Err(Error::LimitExceeded(format!("at most {INSTALLED_MAX} capabilities are installed")));
    }
    let known = tx.capability_versions().find(id, version)?;
    if known.as_ref().is_some_and(|known| known.hash != hash) {
        return Err(Error::Conflict(format!("capability {id} {version} was installed with other files")));
    }
    Ok(known)
}
