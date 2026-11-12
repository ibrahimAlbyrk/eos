//! Sync records cross between the two implementations: what Rust seals,
//! today's TypeScript opens (and parses with the real envelope schema), and
//! what the TypeScript seals now, Rust opens. Each side seals with fresh
//! nonces, so this checks the format, not a fixed vector.
//!
//! It runs the TypeScript sources of this checkout with `node`; without node,
//! or without `contracts`' node modules (`rust/host/scripts/setup.sh`, or
//! `npm ci` in `contracts`), it says so and passes.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::{Engine, engine::general_purpose::STANDARD};
use eos_core::net::sync::SyncCrypto;
use eos_domain::sync::{SyncKeys, parse_sync_key};
use eos_sync_vault::VaultCrypto;
use serde_json::{Value, json};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the checkout")
}

/// `node` running TypeScript sources of this checkout, when they can run here.
fn node() -> Option<Command> {
    let repo = repo();
    if !repo.join("contracts/node_modules/zod").is_dir() {
        eprintln!("skipped: no node modules in contracts (run rust/host/scripts/setup.sh, or npm ci in contracts)");
        return None;
    }
    let found = Command::new("node").arg("--version").output().is_ok_and(|out| out.status.success());
    if !found {
        eprintln!("skipped: no node on PATH");
        return None;
    }
    let mut node = Command::new("node");
    node.args(["--experimental-strip-types", "--no-warnings"]).current_dir(&repo);
    Some(node)
}

fn vectors() -> Value {
    let path = repo().join("rust/crates/eos-domain/tests/fixtures/sync-vectors.json");
    serde_json::from_slice(&std::fs::read(path).expect("the vectors")).expect("json")
}

fn crypto(sync_key: &str) -> VaultCrypto {
    let id = parse_sync_key(sync_key).expect("the vectors' key");
    VaultCrypto::new(SyncKeys::derive(&id.secret))
}

#[test]
fn typescript_opens_what_rust_seals() {
    let Some(mut node) = node() else { return };
    let v = vectors();
    let sync_key = v["syncKey"].as_str().expect("a key");
    let crypto = crypto(sync_key);
    let records: Vec<Value> = v["records"]
        .as_array()
        .expect("records")
        .iter()
        .map(|r| {
            let (domain, id, plaintext) = (r["domain"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or(""), r["plaintext"].as_str().unwrap_or(""));
            let record_key = crypto.record_key(domain, id);
            let sealed = crypto.seal(&record_key, plaintext.as_bytes());
            json!({"domain": domain, "id": id, "recordKey": record_key, "sealed": STANDARD.encode(sealed), "plaintext": plaintext})
        })
        .collect();
    let input = json!({"syncKey": sync_key, "records": records}).to_string();

    let mut child = node
        .arg("rust/spikes/data/ts/sync-open.ts")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node starts");
    child.stdin.take().expect("its input").write_all(input.as_bytes()).expect("written");
    let out = child.wait_with_output().expect("node ends");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let said: Value = serde_json::from_slice(&out.stdout).expect("its answer");
    assert_eq!(said, json!({"opened": records.len(), "wrongNameRejected": true}));
}

#[test]
fn rust_opens_what_typescript_seals() {
    let Some(mut node) = node() else { return };
    let dir = tempfile::tempdir().expect("a folder");
    let out = node.arg("rust/spikes/data/ts/gen-sync-vectors.ts").arg(dir.path()).output().expect("node runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let fresh: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("sync-vectors.json")).expect("written")).expect("json");
    let crypto = crypto(fresh["syncKey"].as_str().expect("a key"));
    let records = fresh["records"].as_array().expect("records");
    assert!(!records.is_empty());
    for r in records {
        let (domain, id) = (r["domain"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or(""));
        let record_key = crypto.record_key(domain, id);
        assert_eq!(r["recordKey"].as_str(), Some(record_key.as_str()), "{domain}/{id}");
        let sealed = STANDARD.decode(r["sealed"].as_str().expect("sealed")).expect("base64");
        let opened = crypto.open(&record_key, &sealed).expect("opens");
        assert_eq!(std::str::from_utf8(&opened).ok(), r["plaintext"].as_str(), "{domain}/{id}");
    }
}
