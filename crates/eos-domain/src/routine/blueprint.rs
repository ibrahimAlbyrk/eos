//! A routine's blueprint as a version stores it: its canonical JSON, whose
//! bytes `eos_contracts::Blueprint` spells out, and the hash of them.

use eos_contracts::Blueprint;
use sha2::{Digest, Sha256};

use crate::sync::stable::stringify;

/// The text a version stores.
pub fn canonical_json(blueprint: &Blueprint) -> String {
    stringify(&serde_json::to_value(blueprint).expect("a blueprint's keys are all strings"))
}

/// What `routine_versions.hash` holds: the lowercase hex SHA-256 of the
/// version's canonical JSON.
pub fn hash(canonical_json: &str) -> String {
    hex::encode(Sha256::digest(canonical_json.as_bytes()))
}
