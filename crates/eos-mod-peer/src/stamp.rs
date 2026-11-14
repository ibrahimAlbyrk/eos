//! The stamp of this build's route surface (`computeApiStamp`).
//!
//! Two apps with the same stamp speak the same routes; a controlling
//! dashboard compares a host's stamp with its own to decide whose bundle to
//! load. The stamp is the first 16 hex characters of the SHA-256 over
//! `eos-rust`, then every route of the contract table as `name=path`, sorted,
//! joined by newlines. The first line keeps it apart from every TypeScript
//! build's stamp on purpose: a TypeScript-era computer loads this app's own
//! dashboard, and this app loads that computer's.

use eos_contracts::routes::ROUTES;
use sha2::{Digest, Sha256};

pub fn api_stamp() -> String {
    let mut surface: Vec<String> = ROUTES.iter().map(|route| format!("{}={}", route.name, route.path)).collect();
    surface.sort();
    let mut hasher = Sha256::new();
    hasher.update(b"eos-rust");
    for line in &surface {
        hasher.update(b"\n");
        hasher.update(line.as_bytes());
    }
    hex::encode(hasher.finalize()).chars().take(16).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stamp_is_stable_and_never_a_typescript_builds() {
        let stamp = api_stamp();
        assert_eq!(stamp.len(), 16);
        assert_eq!(stamp, api_stamp());
        // What the TypeScript daemon of the recorded wire answers (fixtures/wire/recordings/16-services.json).
        assert_ne!(stamp, "07d306e4c80470da");
    }
}
