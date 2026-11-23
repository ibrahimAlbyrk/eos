//! A capability in each state. They are skills, instructions without
//! actions, so a dev run that loads them never runs a package's code.

use eos_core::Error;
use eos_core::store::{StoredCapabilityVersion, StoredInstall, Tx};
use eos_domain::capability::health::{Health, HealthState, StateCode};
use serde_json::{Value, json};

use crate::routine_seed::{BASE_MS, DAY};

const VERSION: &str = "1.0.0";

fn manifest(id: &str, name: &str, summary: &str) -> Value {
    json!({"id": id, "name": name, "version": VERSION, "summary": summary, "form": "skill", "works": "any_mac"})
}

fn samples() -> [(&'static str, &'static str, &'static str, HealthState, Option<StateCode>); 7] {
    [
        ("sample-style", "Review style", "How the team writes reviews.", HealthState::Ready, None),
        (
            "sample-weather",
            "Weather",
            "Today's weather for the morning page.",
            HealthState::Degraded,
            Some(StateCode::RateLimited),
        ),
        ("sample-linear", "Linear", "Reads the team's issues.", HealthState::NeedsSignIn, Some(StateCode::Http401)),
        (
            "sample-notion",
            "Notion",
            "Reads the team's wiki.",
            HealthState::NeedsSetup,
            Some(StateCode::SecretMissing("api_key".to_owned())),
        ),
        ("sample-feeds", "Feeds", "Reads the feeds you follow.", HealthState::Broken, Some(StateCode::HashMismatch)),
        ("sample-sms", "SMS", "Texts you through Messages.", HealthState::Disabled, None),
        ("sample-glossary", "Glossary", "The team's words and what they mean.", HealthState::Available, None),
    ]
}

pub(super) fn write(tx: &dyn Tx) -> Result<(), Error> {
    let at = BASE_MS - 3 * DAY;
    for (id, name, summary, state, code) in samples() {
        let failures = u32::from(matches!(state, HealthState::Degraded | HealthState::Broken));
        tx.capability_versions().insert(&StoredCapabilityVersion {
            capability_id: id.to_owned(),
            version: VERSION.to_owned(),
            status: "installed".to_owned(),
            hash: format!("sha256:{id}"),
            manifest_json: manifest(id, name, summary).to_string(),
            source: "rn-sample000001".to_owned(),
            tests_json: None,
            review_json: None,
            created_at: at,
            activated_at: Some(at),
            retired_at: None,
        })?;
        tx.capability_installs().put(&StoredInstall {
            id: id.to_owned(),
            origin: if state == HealthState::Available { "synced" } else { "forge" }.to_owned(),
            active_version: Some(VERSION.to_owned()),
            health: Health { state, code, failures },
            state_since: at,
            settings_json: "{}".to_owned(),
            account_label: None,
            installed_at: at,
            updated_at: at,
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use eos_domain::capability::manifest::Manifest;

    use super::*;

    #[test]
    fn every_sample_manifest_reads() {
        for (id, name, summary, ..) in samples() {
            let manifest: Manifest = serde_json::from_value(manifest(id, name, summary)).expect("a manifest");
            assert!(manifest.actions.is_empty(), "{id} runs no code");
        }
    }
}
