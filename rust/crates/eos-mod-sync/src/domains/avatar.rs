//! The profile picture: one record, `{ext, b64}`.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use eos_contracts::{AvatarExt, SyncDomainName};
use eos_core::net::sync::SyncDomain;
use eos_core::profile::UserProfileSync;
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::{Value, json};

use super::refused;

/// What the TypeScript's `Buffer.from(text, "base64")` accepts.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
);

pub struct AvatarDomain {
    profile: Arc<dyn UserProfileSync>,
}

impl std::fmt::Debug for AvatarDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AvatarDomain").finish_non_exhaustive()
    }
}

impl AvatarDomain {
    pub fn new(profile: Arc<dyn UserProfileSync>) -> Self {
        Self { profile }
    }

    fn item(&self) -> Result<Option<SyncItem>, Error> {
        let Some(avatar) = self.profile.avatar()? else { return Ok(None) };
        let ext = match avatar.ext {
            AvatarExt::Png => "png",
            AvatarExt::Jpeg => "jpeg",
            AvatarExt::Webp => "webp",
        };
        Ok(Some(SyncItem {
            id: "avatar".to_owned(),
            data: json!({ "ext": ext, "b64": STANDARD.encode(&avatar.bytes) }),
            updated_at: Some(self.profile.get().updated_at.as_f64()),
        }))
    }

    fn apply_now(&self, data: &Value) -> Result<(), Error> {
        let known = data.get("ext").and_then(Value::as_str).is_some_and(|ext| matches!(ext, "png" | "jpeg" | "webp"));
        let encoded = data.get("b64").and_then(Value::as_str).filter(|b64| known && !b64.is_empty());
        let bytes = encoded.and_then(|b64| LENIENT.decode(b64).ok()).ok_or_else(|| refused("not an avatar"))?;
        // The picture's type is read from its bytes, as for one the user picks.
        self.profile.set_avatar(&bytes).map(|_| ())
    }
}

impl SyncDomain for AvatarDomain {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Avatar
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(std::future::ready(self.item().map(|item| item.into_iter().collect())))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        Box::pin(std::future::ready(if id == "avatar" { self.item() } else { Ok(None) }))
    }

    fn apply<'a>(&'a self, _id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(self.apply_now(data)))
    }

    fn remove<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(self.profile.clear_avatar().map(|_| ())))
    }
}
