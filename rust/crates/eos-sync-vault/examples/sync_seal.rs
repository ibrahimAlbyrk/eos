//! Seals the vector file's envelopes in Rust (fresh nonces) and prints them
//! for `spikes/data/ts/sync-open.ts`: the TypeScript code must open what Rust
//! sealed.
//!
//! `cargo run -p eos-sync-vault --example sync_seal -- crates/eos-domain/tests/fixtures/sync-vectors.json`

use base64::{Engine, engine::general_purpose::STANDARD};
use eos_core::net::sync::SyncCrypto;
use eos_domain::sync::{SyncKeys, parse_sync_key};
use eos_sync_vault::VaultCrypto;
use serde_json::{Value, json};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("usage: sync_seal <sync-vectors.json>")?;
    let v: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let sync_key = v["syncKey"].as_str().ok_or("no syncKey")?;
    let id = parse_sync_key(sync_key).ok_or("bad key")?;
    let crypto = VaultCrypto::new(SyncKeys::derive(&id.secret));
    let mut records = Vec::new();
    for r in v["records"].as_array().into_iter().flatten() {
        let (domain, rid, plaintext) =
            (r["domain"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or(""), r["plaintext"].as_str().unwrap_or(""));
        let record_key = crypto.record_key(domain, rid);
        let sealed = crypto.seal(&record_key, plaintext.as_bytes());
        records.push(json!({ "domain": domain, "id": rid, "recordKey": record_key, "sealed": STANDARD.encode(sealed), "plaintext": plaintext }));
    }
    println!("{}", json!({ "syncKey": sync_key, "records": records }));
    Ok(())
}
