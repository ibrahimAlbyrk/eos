//! The profile, one record per group of fields, so edits to different groups
//! on two computers both land. A group at its empty default is "absent": a
//! fresh computer has nothing to conflict with. Never the avatar's type, the
//! revision or the dreaming settings: those are this computer's own.

use std::sync::Arc;

use eos_contracts::{SyncDomainName, UserProfile};
use eos_core::net::sync::SyncDomain;
use eos_core::profile::{SyncedIdentity, SyncedLanguage, SyncedProfileFields, UserProfileSync};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::{SyncItem, stable_stringify};
use eos_domain::user_profile::empty_user_profile;
use serde_json::{Value, json};

use super::refused;

/// The groups, by record id.
const FIELDS: [&str; 8] =
    ["identity", "language", "work", "style", "instructions", "sharing", "budgetTokens", "onboardedAt"];

pub struct ProfileDomain {
    profile: Arc<dyn UserProfileSync>,
}

impl std::fmt::Debug for ProfileDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileDomain").finish_non_exhaustive()
    }
}

/// One group of `profile` as it travels.
fn value_of(profile: &UserProfile, field: &str) -> Value {
    let whole = serde_json::to_value(profile).unwrap_or(Value::Null);
    match field {
        "identity" => json!({
            "fullName": profile.identity.full_name,
            "callName": profile.identity.call_name,
            "handle": profile.identity.handle,
        }),
        _ => whole.get(field).cloned().unwrap_or(Value::Null),
    }
}

/// `data` as the group `field` of a profile, checked by the profile's own rules.
fn parse(field: &str, data: &Value) -> Result<SyncedProfileFields, Error> {
    let mut whole = serde_json::to_value(empty_user_profile()).map_err(Error::storage)?;
    let incoming = match field {
        "identity" => {
            let mut identity = data.as_object().cloned().ok_or_else(|| refused("identity: Expected object"))?;
            identity.insert("avatar".to_owned(), Value::Null);
            Value::Object(identity)
        }
        _ => data.clone(),
    };
    whole[field] = incoming;
    let profile: UserProfile = eos_contracts::validate::parse(&whole).map_err(refused)?;
    let mut fields = SyncedProfileFields::default();
    match field {
        "identity" => {
            fields.identity = Some(SyncedIdentity {
                full_name: profile.identity.full_name,
                call_name: profile.identity.call_name,
                handle: profile.identity.handle,
            });
        }
        "language" => {
            fields.language = Some(SyncedLanguage { chat: profile.language.chat, code: profile.language.code });
        }
        "work" => fields.work = Some(profile.work),
        "style" => fields.style = Some(profile.style),
        "instructions" => fields.instructions = Some(profile.instructions),
        "sharing" => fields.sharing = Some(profile.sharing),
        "budgetTokens" => fields.budget_tokens = Some(profile.budget_tokens),
        "onboardedAt" => fields.onboarded_at = Some(profile.onboarded_at),
        _ => return Err(refused(format!("unknown profile field {field}"))),
    }
    Ok(fields)
}

impl ProfileDomain {
    pub fn new(profile: Arc<dyn UserProfileSync>) -> Self {
        Self { profile }
    }

    fn item(&self, field: &str) -> Option<SyncItem> {
        let profile = self.profile.get();
        let data = value_of(&profile, field);
        let default = value_of(&empty_user_profile(), field);
        (stable_stringify(&data) != stable_stringify(&default)).then(|| SyncItem {
            id: field.to_owned(),
            data,
            updated_at: Some(profile.updated_at.as_f64()),
        })
    }
}

impl SyncDomain for ProfileDomain {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Profile
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(std::future::ready(Ok(FIELDS.iter().filter_map(|field| self.item(field)).collect())))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        let item = FIELDS.contains(&id).then(|| self.item(id)).flatten();
        Box::pin(std::future::ready(Ok(item)))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        let applied = if FIELDS.contains(&id) {
            parse(id, data).and_then(|fields| self.profile.apply_synced(fields)).map(|_| ())
        } else {
            Err(refused(format!("unknown profile field {id}")))
        };
        Box::pin(std::future::ready(applied))
    }

    /// A deleted group goes back to its empty default.
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let removed = if FIELDS.contains(&id) {
            parse(id, &value_of(&empty_user_profile(), id))
                .and_then(|fields| self.profile.apply_synced(fields))
                .map(|_| ())
        } else {
            Ok(())
        };
        Box::pin(std::future::ready(removed))
    }
}
