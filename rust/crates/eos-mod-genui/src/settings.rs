//! The visual-answers switches as one value (`manager/modules/genui/settings.ts`):
//! level, apps and location sharing from `settings.json`, the logo.dev key
//! from the `genui` block of `config.json`. Anything malformed reads as its
//! default, and a bad key is no key.

use std::sync::Arc;

use eos_contracts::{GenuiLevel, GenuiSettings, SettingValue, UserSettings};
use eos_core::store::{ConfigSource, UserSettingsStore};
use eos_domain::config::Config;
use eos_genui::wire::{DEFAULT_APPS, DEFAULT_LOCATION_SHARE, SETTING_APPS, SETTING_LEVEL, SETTING_LOCATION_SHARE};

/// The route that may write the keys below; the flat settings route names it
/// when it refuses them.
pub(crate) const SETTINGS_ROUTE: &str = "/api/settings/genui";
pub(crate) const PROTECTED_KEYS: [&str; 3] = [SETTING_LEVEL, SETTING_APPS, SETTING_LOCATION_SHARE];

fn level(settings: &UserSettings) -> GenuiLevel {
    match settings.get(SETTING_LEVEL) {
        Some(SettingValue::Text(level)) if level == "rich" => GenuiLevel::Rich,
        Some(SettingValue::Text(level)) if level == "text" => GenuiLevel::Text,
        _ => GenuiLevel::Balanced,
    }
}

fn flag(settings: &UserSettings, key: &str, default: bool) -> bool {
    match settings.get(key) {
        Some(SettingValue::Flag(on)) => *on,
        _ => default,
    }
}

pub(crate) fn settings_of(settings: &UserSettings, config: &Config) -> GenuiSettings {
    let key = config.genui.logo_dev_key.as_ref().filter(|key| eos_contracts::check(*key).is_ok());
    GenuiSettings {
        level: level(settings),
        apps: flag(settings, SETTING_APPS, DEFAULT_APPS),
        location_share: flag(settings, SETTING_LOCATION_SHARE, DEFAULT_LOCATION_SHARE),
        logo_dev_key: key.map(|key| key.0.clone()),
    }
}

/// The switches, read from the two files each time: a change in Settings
/// applies to the next call.
#[derive(Clone)]
pub(crate) struct Switches {
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    pub(crate) config: Arc<dyn ConfigSource>,
}

impl Switches {
    pub(crate) fn read(&self) -> GenuiSettings {
        settings_of(&self.settings.read(), &self.config.current())
    }

    pub(crate) fn location_sharing(&self) -> bool {
        flag(&self.settings.read(), SETTING_LOCATION_SHARE, DEFAULT_LOCATION_SHARE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(pairs: &[(&str, SettingValue)]) -> UserSettings {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()
    }

    // `manager/modules/genui/__tests__/settings-routes.test.ts`: "reads malformed values as their defaults".
    #[test]
    fn malformed_values_read_as_their_defaults() {
        let read = |pairs: &[(&str, SettingValue)]| {
            let s = settings(pairs);
            (level(&s), flag(&s, SETTING_APPS, DEFAULT_APPS), flag(&s, SETTING_LOCATION_SHARE, DEFAULT_LOCATION_SHARE))
        };
        assert_eq!(read(&[]), (GenuiLevel::Balanced, true, true));
        assert_eq!(
            read(&[
                (SETTING_LEVEL, SettingValue::Text("loud".into())),
                (SETTING_APPS, SettingValue::Text("yes".into())),
                (SETTING_LOCATION_SHARE, SettingValue::Text("no".into())),
            ]),
            (GenuiLevel::Balanced, true, true)
        );
        assert_eq!(
            read(&[
                (SETTING_LEVEL, SettingValue::Text("text".into())),
                (SETTING_APPS, SettingValue::Flag(false)),
                (SETTING_LOCATION_SHARE, SettingValue::Flag(false)),
            ]),
            (GenuiLevel::Text, false, false)
        );
    }
}
