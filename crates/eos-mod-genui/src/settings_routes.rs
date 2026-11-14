//! Visual answers in Settings: level, apps and location sharing are
//! `settings.json` keys, the logo.dev key sits in the `genui` block of
//! `config.json`. The PUT is the user's alone — the only way location sharing
//! turns on (the flat settings route refuses these keys; see the module's
//! protected settings).

use eos_contracts::{GenuiLevel, GenuiSettingsPatch, GenuiSettingsPatchLogoDevKey, SettingValue, UserSettings};
use eos_genui::wire::{SETTING_APPS, SETTING_LEVEL, SETTING_LOCATION_SHARE};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Map, Value};

use crate::settings::{SETTINGS_ROUTE, Switches};

const FIELDS: [&str; 4] = ["level", "apps", "locationShare", "logoDevKey"];

pub(crate) fn all(switches: Switches) -> Vec<RouteDef> {
    vec![read(switches.clone()), write(switches)]
}

fn read(switches: Switches) -> RouteDef {
    RouteDef::get(SETTINGS_ROUTE, move |_req: Request| {
        let switches = switches.clone();
        async move { Ok(Response::json(200, &switches.read())) }
    })
    .access(Access::open())
}

fn level_name(level: GenuiLevel) -> &'static str {
    match level {
        GenuiLevel::Rich => "rich",
        GenuiLevel::Balanced => "balanced",
        GenuiLevel::Text => "text",
    }
}

/// What a patch does to the logo.dev key.
enum LogoKey {
    Keep,
    Set(String),
    /// `""` and `null` clear it.
    Clear,
}

/// The body as a patch. Unknown fields are refused, as the strict schema did.
fn patch_of(req: &Request) -> Result<(GenuiSettingsPatch, LogoKey), ApiError> {
    let body: Value = req.json()?;
    let unknown: Vec<String> = match &body {
        Value::Object(fields) => {
            fields.keys().filter(|key| !FIELDS.contains(&key.as_str())).map(|key| format!("'{key}'")).collect()
        }
        _ => Vec::new(),
    };
    let patch: GenuiSettingsPatch = req.parse()?;
    if !unknown.is_empty() {
        return Err(ApiError::invalid([("", format!("Unrecognized key(s) in object: {}", unknown.join(", ")))]));
    }
    // The typed patch reads `null` as absent; the body says which it was.
    let logo = match (&patch.logo_dev_key, body.get("logoDevKey")) {
        (Some(GenuiSettingsPatchLogoDevKey::LogoDevKey(key)), _) if !key.0.is_empty() => LogoKey::Set(key.0.clone()),
        (_, Some(_)) => LogoKey::Clear,
        (_, None) => LogoKey::Keep,
    };
    Ok((patch, logo))
}

fn write(switches: Switches) -> RouteDef {
    RouteDef::put(SETTINGS_ROUTE, move |req: Request| {
        let switches = switches.clone();
        async move {
            let (patch, logo) = patch_of(&req)?;
            let mut settings = UserSettings::new();
            if let Some(level) = patch.level {
                settings.insert(SETTING_LEVEL.to_owned(), SettingValue::Text(level_name(level).to_owned()));
            }
            if let Some(apps) = patch.apps {
                settings.insert(SETTING_APPS.to_owned(), SettingValue::Flag(apps));
            }
            if let Some(share) = patch.location_share {
                settings.insert(SETTING_LOCATION_SHARE.to_owned(), SettingValue::Flag(share));
            }
            if !settings.is_empty() {
                switches.settings.patch(settings)?;
            }
            // A `null` in a config patch removes the key: the default (no key) applies again.
            let key = match logo {
                LogoKey::Keep => None,
                LogoKey::Set(key) => Some(Value::String(key)),
                LogoKey::Clear => Some(Value::Null),
            };
            let written = match key {
                Some(key) => switches.config.patch("genui", Map::from_iter([("logoDevKey".to_owned(), key)])).map(drop),
                None => Ok(()),
            };
            if let Err(e) = written {
                return Err(ApiError::Internal(format!("failed to write config: {e}")));
            }
            Ok(Response::json(200, &switches.read()))
        }
    })
    .access(Access::ui_token())
}
