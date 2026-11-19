//! The capabilities there are: built-ins from their code, packages from the
//! tables, read fresh on every ask.

use std::collections::HashSet;

use eos_contracts::ActionClass;
use eos_core::capability::{Capability, CapabilityRegistry};
use eos_core::store::{StoredCapabilityVersion, StoredInstall};
use eos_core::{BoxFuture, Error};
use eos_domain::capability::check::check_builtin;
use eos_domain::capability::health::Health;
use eos_domain::capability::manifest::Manifest;
use serde_json::{Value, json};

use crate::CapabilityService;
use crate::health::announce;

/// The origin of Eos's own capabilities.
pub(crate) const BUILTIN: &str = "builtin";

/// A capability with the hash its active version is pinned to.
pub(crate) struct Loaded {
    pub(crate) capability: Capability,
    /// None for a built-in.
    pub(crate) hash: Option<String>,
}

impl CapabilityService {
    /// At start: moves what an interrupted install left to the trash, and
    /// gives every built-in that has none its row, standing where its
    /// secrets put it until its first check.
    pub async fn start(&self) -> Result<(), Error> {
        let swept = self.ports.files.sweep().await?;
        if swept > 0 {
            tracing::info!(swept, "capability installs left unfinished went to the trash");
        }
        for (id, builtin) in &self.builtins {
            let issues = check_builtin(builtin.manifest());
            if !issues.is_empty() {
                return Err(Error::Rule(format!("the built-in capability {id} has a manifest that fails its check")));
            }
        }
        let known: HashSet<String> = self
            .ports
            .store
            .read(|tx| Ok(tx.capability_installs().list()?.into_iter().map(|install| install.id).collect()))
            .await?;
        let now = self.ports.clock.now_ms();
        let mut rows = Vec::new();
        for (id, builtin) in self.builtins.iter().filter(|(id, _)| !known.contains(*id)) {
            let health = self.fresh_health(builtin.manifest()).await?;
            rows.push(StoredInstall {
                id: id.clone(),
                origin: BUILTIN.to_owned(),
                active_version: None,
                health,
                state_since: now,
                settings_json: "{}".to_owned(),
                account_label: None,
                installed_at: now,
                updated_at: now,
            });
        }
        if rows.is_empty() {
            return Ok(());
        }
        self.ports
            .store
            .write(move |tx, outbox| {
                for row in rows {
                    if tx.capability_installs().find(&row.id)?.is_none() {
                        tx.capability_installs().put(&row)?;
                        announce(outbox, &row);
                    }
                }
                Ok(())
            })
            .await
    }

    /// Every capability, or the one with `id`.
    pub(crate) async fn load(&self, id: Option<&str>) -> Result<Vec<Loaded>, Error> {
        let id = id.map(str::to_owned);
        let rows = self
            .ports
            .store
            .read(move |tx| {
                let installs = match &id {
                    Some(id) => tx.capability_installs().find(id)?.into_iter().collect(),
                    None => tx.capability_installs().list()?,
                };
                installs
                    .into_iter()
                    .map(|install| {
                        let version = match &install.active_version {
                            Some(version) => tx.capability_versions().find(&install.id, version)?,
                            None => None,
                        };
                        Ok((install, version))
                    })
                    .collect::<Result<Vec<_>, Error>>()
            })
            .await?;
        Ok(rows.into_iter().filter_map(|(install, version)| self.assemble(install, version)).collect())
    }

    pub(crate) async fn load_one(&self, id: &str) -> Result<Option<Loaded>, Error> {
        Ok(self.load(Some(id)).await?.pop())
    }

    /// A row as a capability: a built-in with its code's manifest, a package
    /// with its active version's. A built-in whose code is gone, or a
    /// version that cannot be read, is left out.
    fn assemble(&self, install: StoredInstall, version: Option<StoredCapabilityVersion>) -> Option<Loaded> {
        let (manifest, hash) = match (&install.active_version, version) {
            (None, _) if install.origin == BUILTIN => (self.builtins.get(&install.id)?.manifest().clone(), None),
            (Some(_), Some(version)) => match serde_json::from_str::<Manifest>(&version.manifest_json) {
                Ok(manifest) => (manifest, Some(version.hash)),
                Err(_) => {
                    tracing::warn!(capability = %install.id, "a capability's stored manifest cannot be read");
                    return None;
                }
            },
            _ => return None,
        };
        let settings =
            serde_json::from_str::<Value>(&install.settings_json).ok().filter(Value::is_object).unwrap_or(json!({}));
        let capability = Capability {
            id: install.id,
            origin: install.origin,
            version: install.active_version,
            manifest,
            health: install.health,
            settings,
            account_label: install.account_label,
        };
        Some(Loaded { capability, hash })
    }
}

impl CapabilityRegistry for CapabilityService {
    fn list(&self) -> BoxFuture<'_, Result<Vec<Capability>, Error>> {
        Box::pin(async move { Ok(self.load(None).await?.into_iter().map(|loaded| loaded.capability).collect()) })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Capability>, Error>> {
        Box::pin(async move { Ok(self.load_one(id).await?.map(|loaded| loaded.capability)) })
    }

    fn class_of<'a>(&'a self, id: &'a str, action: &'a str) -> BoxFuture<'a, Result<Option<ActionClass>, Error>> {
        Box::pin(async move {
            let loaded = self.load_one(id).await?;
            Ok(loaded.and_then(|loaded| loaded.capability.manifest.action(action).map(|action| action.class)))
        })
    }

    fn state<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Health>, Error>> {
        Box::pin(async move { Ok(self.load_one(id).await?.map(|loaded| loaded.capability.health)) })
    }
}
