//! Capabilities on the user's other computers (06 G11): a definition
//! follows the user as its manifest, its package and its settings, never a
//! secret or a sign-in. On another computer it arrives `available`: its
//! files are there, its code never runs, until the user installs it there,
//! which checks its secrets and the package's files again. A package past
//! [`SYNCED_PACKAGE_MAX_BYTES`] does not travel.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use eos_core::Error;
use eos_core::store::{StoredCapabilityVersion, StoredInstall};
use eos_domain::capability::health::{Health, HealthState};
use eos_domain::capability::manifest::Manifest;
use eos_domain::sync::SyncItem;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::CapabilityService;
use crate::health::announce;
use crate::registry::BUILTIN;

/// The largest package that travels.
pub const SYNCED_PACKAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const SYNCED: &str = "synced";
const INSTALLED: &str = "installed";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    version: String,
    hash: String,
    manifest: Value,
    settings: Value,
    /// Each file of the package by its path, base64.
    files: Vec<(String, String)>,
    installed_at: i64,
}

fn refused(what: impl std::fmt::Display) -> Error {
    Error::Validation(what.to_string())
}

fn available() -> Health {
    Health { state: HealthState::Available, code: None, failures: 0 }
}

impl CapabilityService {
    /// Every capability this computer has that travels, in its portable form.
    pub async fn synced_list(&self) -> Result<Vec<SyncItem>, Error> {
        let installs = self.ports.store.read(|tx| tx.capability_installs().list()).await?;
        let mut items = Vec::new();
        for install in installs {
            if let Some(item) = self.definition(install).await? {
                items.push(item);
            }
        }
        Ok(items)
    }

    pub async fn synced_get(&self, id: &str) -> Result<Option<SyncItem>, Error> {
        let owned = id.to_owned();
        match self.ports.store.read(move |tx| tx.capability_installs().find(&owned)).await? {
            Some(install) => self.definition(install).await,
            None => Ok(None),
        }
    }

    async fn definition(&self, install: StoredInstall) -> Result<Option<SyncItem>, Error> {
        let Some(version) = install.active_version.clone().filter(|_| install.origin != BUILTIN) else {
            return Ok(None);
        };
        let (id, at) = (install.id.clone(), version.clone());
        let Some(row) = self.ports.store.read(move |tx| tx.capability_versions().find(&id, &at)).await? else {
            return Ok(None);
        };
        let files = self.ports.files.package(&install.id, &version).await?;
        if files.iter().map(|(_, bytes)| bytes.len() as u64).sum::<u64>() > SYNCED_PACKAGE_MAX_BYTES {
            return Ok(None);
        }
        let definition = Definition {
            version,
            hash: row.hash,
            manifest: serde_json::from_str(&row.manifest_json).map_err(Error::storage)?,
            settings: serde_json::from_str(&install.settings_json).unwrap_or(Value::Null),
            files: files.into_iter().map(|(path, bytes)| (path, STANDARD.encode(bytes))).collect(),
            installed_at: install.installed_at,
        };
        let data = serde_json::to_value(definition).map_err(Error::storage)?;
        Ok(Some(SyncItem { id: install.id, data, updated_at: Some(install.updated_at as f64) }))
    }

    /// Keeps another computer's definition as `available`. A capability
    /// installed here keeps its own version and takes only the settings.
    pub async fn synced_apply(&self, id: &str, data: &Value) -> Result<(), Error> {
        let definition: Definition = serde_json::from_value(data.clone()).map_err(refused)?;
        let manifest: Manifest = serde_json::from_value(definition.manifest.clone()).map_err(refused)?;
        if manifest.id != id || manifest.version != definition.version {
            return Err(refused("the definition is of another capability"));
        }
        if self.builtins.contains_key(id) {
            return Err(refused("a built-in capability never comes through sync"));
        }
        let owned = id.to_owned();
        let before = self.ports.store.read(move |tx| tx.capability_installs().find(&owned)).await?;
        let settings_json = definition.settings.to_string();
        if let Some(before) = before.as_ref().filter(|before| before.health.state != HealthState::Available) {
            let mut install = before.clone();
            install.settings_json = settings_json;
            return self.ports.store.write(move |tx, _| tx.capability_installs().put(&install)).await;
        }
        let (id, version, hash) = (id.to_owned(), definition.version.clone(), definition.hash.clone());
        let known = {
            let (id, version) = (id.clone(), version.clone());
            self.ports.store.read(move |tx| tx.capability_versions().find(&id, &version)).await?
        };
        if known.as_ref().is_some_and(|known| known.hash != hash) {
            return Err(refused("this version was kept here with other files"));
        }
        if known.is_none() {
            let mut files = Vec::with_capacity(definition.files.len());
            for (path, encoded) in &definition.files {
                files.push((path.clone(), STANDARD.decode(encoded).map_err(|_| refused("a file is not base64"))?));
            }
            self.ports.files.install_files(files, &id, &version, &hash).await?;
        }
        let manifest_json = serde_json::to_string(&manifest).map_err(Error::storage)?;
        let now = self.ports.clock.now_ms();
        self.ports
            .store
            .write(move |tx, outbox| {
                if tx.capability_versions().find(&id, &version)?.is_none() {
                    tx.capability_versions().insert(&StoredCapabilityVersion {
                        capability_id: id.clone(),
                        version: version.clone(),
                        status: INSTALLED.to_owned(),
                        hash,
                        manifest_json,
                        source: SYNCED.to_owned(),
                        tests_json: None,
                        review_json: None,
                        created_at: now,
                        activated_at: Some(now),
                        retired_at: None,
                    })?;
                }
                let install = StoredInstall {
                    id,
                    origin: SYNCED.to_owned(),
                    active_version: Some(version),
                    health: available(),
                    state_since: now,
                    settings_json,
                    account_label: None,
                    installed_at: definition.installed_at,
                    updated_at: now,
                };
                tx.capability_installs().put(&install)?;
                announce(outbox, &install);
                Ok(())
            })
            .await
    }

    /// Another computer removed it: one that only arrived here goes too.
    pub async fn synced_remove(&self, id: &str) -> Result<(), Error> {
        let owned = id.to_owned();
        let found = self.ports.store.read(move |tx| tx.capability_installs().find(&owned)).await?;
        match found {
            Some(install) if install.health.state == HealthState::Available => self.remove(id).await,
            _ => Ok(()),
        }
    }

    /// Installs here a capability that arrived from another computer: its
    /// files must still be the ones it came with, and it needs its secrets
    /// entered on this computer: a removed capability's kept under its id
    /// are forgotten.
    pub async fn install_here(&self, id: &str) -> Result<(), Error> {
        let loaded = self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?;
        if loaded.capability.health.state != HealthState::Available {
            return Err(Error::Conflict(format!("{id} is installed on this computer already")));
        }
        let version = loaded.capability.manifest.version.clone();
        let pinned = loaded.hash.clone().unwrap_or_default();
        if self.ports.files.hash(id, &version).await? != pinned {
            return Err(Error::Rule(format!("{id}: its files are not the ones it came with")));
        }
        // What the Keychain keeps under the id here is a removed capability's.
        self.forget_kept_secrets(&loaded.capability.manifest).await?;
        let health = self.fresh_health(&loaded.capability.manifest).await?;
        let (id, now) = (id.to_owned(), self.ports.clock.now_ms());
        self.ports
            .store
            .write(move |tx, outbox| {
                let mut install =
                    tx.capability_installs().find(&id)?.ok_or_else(|| Error::not_found("capability", &id))?;
                if install.health.state != HealthState::Available {
                    return Ok(());
                }
                install.health = health;
                install.state_since = now;
                install.updated_at = now;
                tx.capability_installs().put(&install)?;
                announce(outbox, &install);
                Ok(())
            })
            .await
    }
}
