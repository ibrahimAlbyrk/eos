//! `GET`/`PUT /api/settings/surfaces`: how surfaces read on this Mac (text
//! size, more contrast, plain reading), kept in `settings.json` under keys
//! only the `PUT` writes. Both answer the settings as they read then.

use std::sync::Arc;

use eos_contracts::{Num, SettingValue, SurfaceSettings, UserSettings};
use eos_core::Error;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use crate::SurfacesParts;

const TEXT_SCALE: &str = "surfaces.textScale";
const CONTRAST: &str = "surfaces.contrast";
const PLAIN: &str = "surfaces.plain";
pub(crate) const KEYS: [&str; 3] = [TEXT_SCALE, CONTRAST, PLAIN];

/// The settings as stored; a missing or unknown value reads as its default.
fn current(stored: &UserSettings) -> SurfaceSettings {
    let defaults = SurfaceSettings::default();
    let text_scale = match stored.get(TEXT_SCALE) {
        Some(SettingValue::Number(n)) => n.as_i64().and_then(|n| u16::try_from(n).ok()),
        _ => None,
    };
    let contrast = match stored.get(CONTRAST) {
        Some(SettingValue::Text(word)) if word == "more" => Some(word.clone()),
        _ => None,
    };
    SurfaceSettings {
        text_scale: text_scale.filter(|n| [100, 115, 130].contains(n)).unwrap_or(defaults.text_scale),
        contrast: contrast.unwrap_or(defaults.contrast),
        plain: matches!(stored.get(PLAIN), Some(SettingValue::Flag(true))),
    }
}

pub(crate) fn all(parts: &Arc<SurfacesParts>) -> Vec<RouteDef> {
    let at = parts.clone();
    let read = RouteDef::get("/api/settings/surfaces", move |_req: Request| {
        let at = at.clone();
        async move {
            let store = at.settings.clone();
            let stored = tokio::task::spawn_blocking(move || store.read())
                .await
                .map_err(|error| Error::Storage(error.to_string()))?;
            Ok(Response::json(200, &current(&stored)))
        }
    });
    let at = parts.clone();
    let write = RouteDef::put("/api/settings/surfaces", move |req: Request| {
        let at = at.clone();
        async move {
            let asked: SurfaceSettings = req.parse()?;
            let partial: UserSettings = [
                (TEXT_SCALE.to_owned(), SettingValue::Number(Num::from(i64::from(asked.text_scale)))),
                (CONTRAST.to_owned(), SettingValue::Text(asked.contrast)),
                (PLAIN.to_owned(), SettingValue::Flag(asked.plain)),
            ]
            .into();
            let store = at.settings.clone();
            let stored = tokio::task::spawn_blocking(move || store.patch(partial))
                .await
                .map_err(|error| Error::Storage(error.to_string()))??;
            let saved = current(&stored);
            tracing::info!(
                text_scale = saved.text_scale,
                plain = saved.plain,
                "the surfaces' reading settings changed"
            );
            Ok(Response::json(200, &saved))
        }
    });
    vec![read.access(Access::open().phone(Tier::Read)), write.access(Access::ui_token().phone_user(Tier::Low))]
}
