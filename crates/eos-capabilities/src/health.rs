//! Where a capability stands: its secrets, its package's hash, its health
//! check, and what a call's outcome does to its health (`Health::after`).

use std::collections::HashMap;

use eos_contracts::CapabilitiesChange;
use eos_core::Error;
use eos_core::capability::{ActionContext, ActionError, FailureKind};
use eos_core::store::{Outbox, StoredInstall, Tx};
use eos_domain::capability::health::{Event, Health, StateCode};
use eos_domain::capability::manifest::Manifest;
use serde_json::json;
use zeroize::Zeroizing;

use crate::registry::Loaded;
use crate::{CAPABILITIES_CHANGE, CapabilityService};

/// What a failed run tells of the capability's health; `None` when the
/// failure is the call's own (its input, a refusal of it).
pub(crate) fn event_of(error: &ActionError) -> Option<Event> {
    match error {
        ActionError::RateLimited { .. } => Some(Event::RateLimited),
        ActionError::Timeout | ActionError::Failed { kind: FailureKind::Service } => Some(Event::CallFailed),
        ActionError::Failed { kind: FailureKind::Unauthorized } => Some(Event::Unauthorized),
        ActionError::Failed { kind: FailureKind::Output } => Some(Event::BadOutput),
        ActionError::NotReady(code) => match StateCode::parse(code)? {
            StateCode::Http401 => Some(Event::Unauthorized),
            StateCode::ScopeMissing => Some(Event::ScopeMissing),
            StateCode::HashMismatch => Some(Event::HashMismatch),
            StateCode::SandboxUnavailable => Some(Event::SandboxUnavailable),
            code @ (StateCode::SecretMissing(_)
            | StateCode::ClientIdMissing
            | StateCode::AutomationDenied
            | StateCode::ProgramMissing
            | StateCode::SourceGone) => Some(Event::Missing(code)),
            StateCode::RateLimited | StateCode::HealthFailed | StateCode::OutputSchema => None,
        },
        _ => None,
    }
}

fn not_ready(code: StateCode) -> ActionError {
    ActionError::NotReady(code.as_string())
}

/// Announces the capability's state as its row now has it.
pub(crate) fn announce(outbox: &mut Outbox, install: &StoredInstall) {
    tracing::info!(
        capability = %install.id,
        state = install.health.state.as_str(),
        code = install.health.code.as_ref().map(StateCode::as_string),
        "capability state"
    );
    outbox.push(
        CAPABILITIES_CHANGE,
        &CapabilitiesChange {
            id: install.id.clone(),
            state: install.health.state.as_str().to_owned(),
            state_code: install.health.code.as_ref().map(StateCode::as_string),
            version: install.active_version.clone(),
        },
    );
}

/// Keeps what `event` does to the capability's health, inside a write job;
/// a change of its state or code is announced once the job commits. `None`
/// when the capability is gone.
pub(crate) fn apply(
    tx: &dyn Tx,
    outbox: &mut Outbox,
    id: &str,
    event: Event,
    now: i64,
) -> Result<Option<Health>, Error> {
    let Some(mut install) = tx.capability_installs().find(id)? else { return Ok(None) };
    let health = install.health.after(event);
    if health != install.health {
        let moved = health.state != install.health.state || health.code != install.health.code;
        if health.state != install.health.state {
            install.state_since = now;
        }
        install.health = health.clone();
        install.updated_at = now;
        tx.capability_installs().put(&install)?;
        if moved {
            announce(outbox, &install);
        }
    }
    Ok(Some(health))
}

impl CapabilityService {
    /// Every secret the manifest asks for, by name; the first one not set
    /// fails as `secret_missing:<name>`.
    pub(crate) async fn secrets_of(
        &self,
        manifest: &Manifest,
    ) -> Result<HashMap<String, Zeroizing<String>>, ActionError> {
        let mut values = HashMap::new();
        for secret in &manifest.secrets {
            match self.ports.secrets.read(&manifest.id, &secret.name).await {
                Ok(Some(value)) => {
                    values.insert(secret.name.clone(), value);
                }
                Ok(None) => return Err(not_ready(StateCode::SecretMissing(secret.name.clone()))),
                Err(e) => {
                    tracing::warn!(capability = %manifest.id, error = %e, "a capability's secret could not be read");
                    return Err(ActionError::Failed { kind: FailureKind::Internal });
                }
            }
        }
        Ok(values)
    }

    /// Where a capability stands before its first check: it needs setting
    /// up while one of its secrets is not set.
    pub(crate) async fn fresh_health(&self, manifest: &Manifest) -> Result<Health, Error> {
        for secret in &manifest.secrets {
            if !self.ports.secrets.has(&manifest.id, &secret.name).await? {
                return Ok(Health::fresh(Event::Missing(StateCode::SecretMissing(secret.name.clone()))));
            }
        }
        Ok(Health::ready())
    }

    /// The installed version's files still hash to `pinned`. They are hashed
    /// again only when their stamp changed since they last did.
    pub(crate) async fn verify_package(&self, id: &str, version: &str, pinned: &str) -> Result<(), ActionError> {
        let key = (id.to_owned(), version.to_owned());
        let files = &self.ports.files;
        let stamp = files.stamp(id, version).await.map_err(|_| not_ready(StateCode::HashMismatch))?;
        if self.stamps.lock().unwrap_or_else(|p| p.into_inner()).get(&key) == Some(&stamp) {
            return Ok(());
        }
        let hash = files.hash(id, version).await.map_err(|_| not_ready(StateCode::HashMismatch))?;
        let mut stamps = self.stamps.lock().unwrap_or_else(|p| p.into_inner());
        if hash == pinned {
            stamps.insert(key, stamp);
            Ok(())
        } else {
            stamps.remove(&key);
            Err(not_ready(StateCode::HashMismatch))
        }
    }

    /// Runs the capability's health check and keeps what it found.
    pub async fn check(&self, id: &str) -> Result<Health, Error> {
        let loaded = self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?;
        let event = self.probe(&loaded).await;
        let (id, now) = (id.to_owned(), self.ports.clock.now_ms());
        let health = self.ports.store.write(move |tx, outbox| apply(tx, outbox, &id, event, now)).await?;
        health.ok_or_else(|| Error::not_found("capability", loaded.capability.id))
    }

    /// What the health check finds: its secrets set, a package's files
    /// unchanged, then the built-in's own check or the package's health
    /// action. A package without one passes on its files alone.
    async fn probe(&self, loaded: &Loaded) -> Event {
        let capability = &loaded.capability;
        let found = |error: ActionError| match event_of(&error) {
            Some(Event::CallFailed) | None => Event::CheckFailed,
            Some(event) => event,
        };
        let secrets = match self.secrets_of(&capability.manifest).await {
            Ok(secrets) => secrets,
            Err(error) => return found(error),
        };
        match (&capability.version, self.builtins.get(&capability.id)) {
            (None, Some(builtin)) => {
                let ctx = ActionContext { secrets, settings: capability.settings.clone(), idempotency_key: None };
                builtin.health(&ctx).await
            }
            (Some(version), _) => {
                let check =
                    capability.manifest.health.as_ref().and_then(|check| capability.manifest.action(&check.action));
                let checked = match check {
                    Some(action) => self.run_package(loaded, version, action, json!({}), secrets).await.map(drop),
                    None => {
                        self.verify_package(&capability.id, version, loaded.hash.as_deref().unwrap_or_default()).await
                    }
                };
                checked.map_or_else(found, |()| Event::Passed)
            }
            (None, None) => Event::CheckFailed,
        }
    }
}
