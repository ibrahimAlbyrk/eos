//! The app's configuration: built-in defaults, overridden by environment
//! variables, overridden by `config.json`.
//!
//! Everything here is pure: the caller hands in the environment and the
//! file's JSON, and gets an immutable [`Config`] back. Reading and writing the
//! file is `eos-config`'s.
//!
//! The file keeps today's keys, so one `config.json` serves both
//! implementations while they exist side by side. Keys that only describe the
//! TypeScript daemon's process (its ports, pid file, script paths) are
//! accepted and not carried: there is no daemon here.

mod defaults;
mod merge;
mod model;
mod overrides;

use serde_json::Value;

pub use defaults::{Env, Host};
pub use eos_contracts::ModelPricing;
pub use model::*;
pub use overrides::ConfigOverride;

/// A backend kind as it is called today: the Claude lanes of earlier versions
/// are one backend now, so a kind an old client or an old row still names
/// stands for it.
pub fn current_backend_kind(kind: &str) -> &str {
    overrides::renamed_kind(kind).unwrap_or(kind)
}

/// Why a `config.json` was not applied. The defaults still stand: a broken
/// file never stops the app from starting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected(pub String);

/// The configuration for `host`, with `file` (the parsed `config.json`, if
/// there is one) applied over the defaults. A file that fails its checks is
/// ignored whole, as today, and the reason is returned beside the defaults.
pub fn resolve(host: &Host, file: Option<Value>) -> (Config, Option<Rejected>) {
    let base = defaults::defaults(host);
    let Some(mut raw) = file else { return (built_in(base), None) };
    overrides::migrate_legacy(&mut raw);
    let merged = overrides::check(&raw).and_then(|accepted| {
        // An entry the file starts (a new micro task, say) may lack fields the model needs.
        serde_json::from_value(merge::merge(base.clone(), &accepted)).map_err(|e| e.to_string())
    });
    match merged {
        Ok(config) => (config, None),
        Err(reason) => (built_in(base), Some(Rejected(reason))),
    }
}

/// The defaults always fit the model: a test holds that for every environment
/// override, so failing here is a bug in this module, not bad input.
fn built_in(defaults: Value) -> Config {
    match serde_json::from_value(defaults) {
        Ok(config) => config,
        Err(e) => panic!("the built-in configuration does not fit its own model: {e}"),
    }
}

/// The price of `model`: its own entry, else its Claude family's, else
/// `None` (the caller asks the price catalog, then bills nothing).
pub fn price_for_model<'c>(config: &'c Config, model: Option<&str>) -> Option<&'c ModelPricing> {
    let name = model.unwrap_or("opus").to_lowercase();
    config.prices.get(&name).or_else(|| {
        ["fable", "opus", "sonnet", "haiku"]
            .into_iter()
            .find(|family| name.contains(family))
            .and_then(|f| config.prices.get(f))
    })
}

#[cfg(test)]
mod tests;
