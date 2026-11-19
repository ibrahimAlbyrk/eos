//! What the user changes by hand: switching a capability off and on, and
//! its settings. Settings are the user's: never logged.

use eos_core::Error;
use eos_domain::capability::health::{Event, HealthState};
use serde_json::{Map, Value};

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
}
