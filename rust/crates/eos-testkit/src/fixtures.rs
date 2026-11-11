//! The recorded wire (`rust/fixtures/wire`) and its invented data.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

/// `rust/fixtures/wire`.
pub fn wire_dir() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/wire"))
}

/// The seed rows of the synthetic data folder, with `{sandbox}` filled in.
/// For a database whose migrations have run.
pub fn seed_sql(sandbox: &str) -> String {
    let path = wire_dir().join("seed/state.sql");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())).replace("{sandbox}", sandbox)
}

/// One scenario's recording, e.g. `recording("11-chats")`.
pub fn recording(scenario: &str) -> Value {
    let path = wire_dir().join("recordings").join(format!("{scenario}.json"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// What a recorded step answered: its normalized response document
/// (`status`, `headers`, `json` or `text`, `frames`).
pub fn recorded_response(scenario: &str, step: &str) -> Value {
    let recording = recording(scenario);
    recording["exchanges"]
        .as_array()
        .and_then(|all| all.iter().find(|e| e["step"]["name"] == step))
        .map(|e| e["response"].clone())
        .unwrap_or_else(|| panic!("{scenario} has no step named {step}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recordings_load_by_scenario_and_step() {
        assert_eq!(recorded_response("10-health", "health")["json"]["ok"], true);
        assert!(seed_sql("/s").contains("'/s/alpha'"));
    }
}
