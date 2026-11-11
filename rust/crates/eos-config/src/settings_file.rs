use std::path::PathBuf;
use std::sync::Mutex;

use eos_contracts::UserSettings;
use eos_core::Error;
use eos_core::store::UserSettingsStore;
use eos_kit_fs::{WriteOptions, atomic_write};

/// `settings.json` (`manager/services/UserSettingsService.ts`): a flat map
/// the dashboard reads and patches. A missing or invalid file reads as empty.
#[derive(Debug)]
pub struct SettingsFile {
    path: PathBuf,
    /// One patch at a time: read, merge, write.
    patching: Mutex<()>,
}

impl SettingsFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), patching: Mutex::new(()) }
    }
}

impl UserSettingsStore for SettingsFile {
    fn read(&self) -> UserSettings {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|json| eos_contracts::parse::<UserSettings>(&json).ok())
            .unwrap_or_default()
    }

    fn patch(&self, partial: UserSettings) -> Result<UserSettings, Error> {
        let _one_at_a_time = self.patching.lock().unwrap_or_else(|p| p.into_inner());
        let mut merged = self.read();
        merged.extend(partial);
        let mut text = serde_json::to_string_pretty(&merged).map_err(Error::storage)?;
        text.push('\n');
        atomic_write(&self.path, text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)?;
        Ok(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_contracts::SettingValue;
    use eos_testkit::TempHome;

    #[test]
    fn settings_are_patched_key_by_key() {
        let home = TempHome::new();
        let settings = SettingsFile::new(home.join("settings.json"));
        assert!(settings.read().is_empty());

        let first = UserSettings::from_iter([
            ("theme".to_owned(), SettingValue::Text("dark".into())),
            ("paths.peek".to_owned(), SettingValue::Flag(false)),
        ]);
        settings.patch(first).expect("writes");
        let merged = settings
            .patch(UserSettings::from_iter([("paths.peek".to_owned(), SettingValue::Flag(true))]))
            .expect("writes");
        assert_eq!(merged.get("theme"), Some(&SettingValue::Text("dark".into())));
        assert_eq!(merged.get("paths.peek"), Some(&SettingValue::Flag(true)));
        assert_eq!(home.read("settings.json"), "{\n  \"theme\": \"dark\",\n  \"paths.peek\": true\n}\n");
        assert_eq!(settings.read(), merged);

        home.write("settings.json", "[1, 2]");
        assert!(settings.read().is_empty(), "not a settings map: read as empty");
    }
}
