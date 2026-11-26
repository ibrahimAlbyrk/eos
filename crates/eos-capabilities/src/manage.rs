//! What the user changes by hand: switching a capability off and on, its
//! settings and its secrets. Settings and secrets are the user's: never
//! logged.

use eos_core::Error;
use eos_domain::capability::health::{Event, HealthState};
use eos_domain::capability::manifest::Secret;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::CapabilityService;
use crate::health::{announce, apply};

impl CapabilityService {
    /// Switches the capability off: its calls are refused until the user
    /// switches it on again.
    pub async fn disable(&self, id: &str) -> Result<(), Error> {
        let (owned, now) = (id.to_owned(), self.ports.clock.now_ms());
        let found = self.ports.store.write(move |tx, outbox| apply(tx, outbox, &owned, Event::Disabled, now)).await?;
        found.map(drop).ok_or_else(|| Error::not_found("capability", id))
    }

    /// Switches a capability that was off on again: it stands where its
    /// secrets put it until its next check. One that is on stays as it is.
    pub async fn enable(&self, id: &str) -> Result<(), Error> {
        let loaded = self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?;
        if loaded.capability.health.state != HealthState::Disabled {
            return Ok(());
        }
        let health = self.fresh_health(&loaded.capability.manifest).await?;
        let (id, now) = (id.to_owned(), self.ports.clock.now_ms());
        self.ports
            .store
            .write(move |tx, outbox| {
                let mut install =
                    tx.capability_installs().find(&id)?.ok_or_else(|| Error::not_found("capability", &id))?;
                if install.health.state != HealthState::Disabled {
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

    /// Sets the named settings; an empty value clears one. A name the
    /// capability does not declare, or a choice it does not offer, is refused.
    pub async fn set_settings(&self, id: &str, values: Vec<(String, String)>) -> Result<(), Error> {
        let loaded = self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?;
        let declared = &loaded.capability.manifest.settings;
        for (name, value) in &values {
            let setting = declared
                .iter()
                .find(|setting| &setting.name == name)
                .ok_or_else(|| Error::Validation(format!("{id} has no setting {name}")))?;
            if !value.is_empty() && !setting.choices.is_empty() && !setting.choices.contains(value) {
                return Err(Error::Validation(format!("{name} is one of the choices {id} offers")));
            }
        }
        let (id, now) = (id.to_owned(), self.ports.clock.now_ms());
        self.ports
            .store
            .write(move |tx, _| {
                let mut install =
                    tx.capability_installs().find(&id)?.ok_or_else(|| Error::not_found("capability", &id))?;
                let mut settings =
                    serde_json::from_str::<Map<String, Value>>(&install.settings_json).unwrap_or_default();
                for (name, value) in values {
                    if value.is_empty() {
                        settings.remove(&name);
                    } else {
                        settings.insert(name, Value::String(value));
                    }
                }
                install.settings_json = Value::Object(settings).to_string();
                install.updated_at = now;
                tx.capability_installs().put(&install)
            })
            .await
    }

    /// Whether the capability's secret `name` is set; never its value.
    pub async fn secret_set(&self, id: &str, name: &str) -> Result<bool, Error> {
        self.ports.secrets.has(id, name).await
    }

    /// The secret `name` the capability declares, or 404.
    pub async fn declared_secret(&self, id: &str, name: &str) -> Result<(String, Secret), Error> {
        let loaded = self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?;
        let manifest = loaded.capability.manifest;
        let secret = manifest.secrets.into_iter().find(|secret| secret.name == name);
        Ok((manifest.name, secret.ok_or_else(|| Error::not_found("secret", name))?))
    }

    /// Keeps the value the user entered for secret `name`, then checks the
    /// capability again. Its running code is stopped: it read the old value.
    pub async fn enter_secret(&self, id: &str, name: &str, value: Zeroizing<String>) -> Result<(), Error> {
        self.declared_secret(id, name).await?;
        self.ports.secrets.write(id, name, value).await?;
        tracing::info!(capability = id, "a capability's secret was entered");
        self.after_secret(id).await
    }

    /// Forgets secret `name`; the capability needs it again before it is
    /// called. The account's label goes too: it named whom the secret
    /// signed in as. So do the secrets a built-in keeps beside it.
    pub async fn forget_secret(&self, id: &str, name: &str) -> Result<(), Error> {
        self.declared_secret(id, name).await?;
        self.ports.secrets.delete(id, name).await?;
        for undeclared in self.builtins.get(id).map_or(&[][..], |builtin| builtin.undeclared_secrets()) {
            self.ports.secrets.delete(id, undeclared).await?;
        }
        self.keep_label(id, None).await?;
        tracing::info!(capability = id, "a capability's secret was forgotten");
        self.after_secret(id).await
    }

    async fn after_secret(&self, id: &str) -> Result<(), Error> {
        if let Some(runner) = &self.ports.runner {
            runner.stop(id).await;
        }
        let loaded = self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?;
        if loaded.capability.health.state == HealthState::Disabled {
            return Ok(());
        }
        self.check(id).await.map(drop)
    }
}
