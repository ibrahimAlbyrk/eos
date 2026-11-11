//! Seals the fixture's envelopes in Rust (fresh nonces) and prints them for
//! ts/sync-open.ts: the TypeScript code must open what Rust sealed.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use spike_sync::key::{SyncKeys, parse_sync_key};

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: sync-seal <vectors.json>"))?;
    let v: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let sync_key = v["syncKey"].as_str().ok_or_else(|| anyhow::anyhow!("no syncKey"))?;
    let id = parse_sync_key(sync_key).ok_or_else(|| anyhow::anyhow!("bad key"))?;
    let keys = SyncKeys::derive(&id.secret);
    let mut records = Vec::new();
    for r in v["records"].as_array().into_iter().flatten() {
        let (domain, rid, plaintext) =
            (r["domain"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or(""), r["plaintext"].as_str().unwrap_or(""));
        let record_key = keys.record_key(domain, rid);
        let sealed = keys.seal(&record_key, plaintext.as_bytes());
        records.push(json!({ "domain": domain, "id": rid, "recordKey": record_key, "sealed": STANDARD.encode(sealed), "plaintext": plaintext }));
    }
    println!("{}", json!({ "syncKey": sync_key, "records": records }));
    Ok(())
}
