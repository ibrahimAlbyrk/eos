//! The two configuration files of the data folder.
//!
//! - [`ConfigFile`]: `config.json` over the built-in defaults and the
//!   environment. What is in force is an immutable snapshot (`Arc<Config>`);
//!   a reload swaps it, and the only way to change it is to patch the file.
//!   The rules themselves (defaults, what a file may hold, how it merges) are
//!   `eos_domain::config`.
//! - [`SettingsFile`]: `settings.json`, the user's flat settings.
//!
//! A broken file never stops the app: it is reported once and the defaults stand.

mod config_file;
mod settings_file;

pub use config_file::{ConfigFile, env_from_process};
pub use settings_file::SettingsFile;
