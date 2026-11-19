//! What an agent is told of the capabilities it may call, and what the
//! user does to make one work that does not.

use eos_core::Error;
use eos_core::capability::{ActionDescription, Capability, CapabilityDescription};
use eos_domain::capability::health::{HealthState, StateCode};

use crate::CapabilityService;
use crate::call::allows;

/// The step that makes the capability work, in words an agent passes on.
fn setup(capability: &Capability) -> Option<String> {
    let place = "in Eos › Capabilities";
    let text = match (capability.health.state, &capability.health.code) {
        (HealthState::Ready | HealthState::Degraded, _) => return None,
        (HealthState::NeedsSignIn, _) => format!("The user signs in to {} again {place}.", capability.manifest.name),
        (HealthState::NeedsSetup, Some(StateCode::SecretMissing(name))) => {
            let secret = capability.manifest.secrets.iter().find(|secret| &secret.name == name);
            let label = secret.map_or(name.as_str(), |secret| secret.label.as_str());
            format!("The user enters {label} {place}.")
        }
        (HealthState::NeedsSetup, Some(StateCode::ClientIdMissing)) => {
            "The user sets the GitHub client id (github.clientId in config.json).".to_owned()
        }
        (HealthState::NeedsSetup, Some(StateCode::AutomationDenied)) => {
            "The user allows Eos to control the app in System Settings › Privacy & Security › Automation.".to_owned()
        }
        (HealthState::NeedsSetup, Some(StateCode::ProgramMissing)) => {
            format!("The user installs what it needs: {}.", capability.manifest.requires.programs.join(", "))
        }
        (HealthState::NeedsSetup, _) => format!("The user finishes setting it up {place}."),
        (HealthState::Broken, code) => format!(
            "It is broken ({}): the user repairs it or goes back to an earlier version {place}.",
            code.as_ref().map_or_else(|| "broken".to_owned(), StateCode::as_string)
        ),
        (HealthState::Disabled, _) => format!("The user switched it off; they switch it on {place}."),
        (HealthState::Available, _) => format!("It is set up on another Mac; the user installs it here {place}."),
    };
    Some(text)
}

impl CapabilityService {
    pub(crate) async fn describe_for(
        &self,
        worker_id: &str,
        id: Option<&str>,
    ) -> Result<Vec<CapabilityDescription>, Error> {
        let grant = self.ports.grants.grant(worker_id).await;
        let loaded = match id {
            Some(id) => vec![self.load_one(id).await?.ok_or_else(|| Error::not_found("capability", id))?],
            None => self.load(None).await?,
        };
        let mut described = Vec::new();
        for loaded in loaded {
            let capability = &loaded.capability;
            let manifest = &capability.manifest;
            let actions: Vec<ActionDescription> = manifest
                .actions
                .iter()
                .filter(|action| grant.as_ref().is_none_or(|grant| allows(grant, &capability.id, action)))
                .map(|action| ActionDescription {
                    name: action.name.clone(),
                    summary: action.summary.clone(),
                    class: action.class,
                    input: id.and(action.input.clone()),
                })
                .collect();
            if actions.is_empty() && !manifest.actions.is_empty() {
                continue;
            }
            let instructions = match (id, &capability.version, &manifest.instructions) {
                (Some(_), Some(version), Some(file)) => {
                    match self.ports.files.read_text(&capability.id, version, file).await {
                        Ok(text) => Some(text),
                        Err(e) => {
                            tracing::warn!(capability = %capability.id, error = %e, "a capability's instructions could not be read");
                            None
                        }
                    }
                }
                _ => None,
            };
            described.push(CapabilityDescription {
                id: capability.id.clone(),
                name: manifest.name.clone(),
                summary: manifest.summary.clone(),
                state: capability.health.state,
                state_code: capability.health.code.clone(),
                setup: setup(capability),
                actions,
                instructions,
            });
        }
        Ok(described)
    }
}
