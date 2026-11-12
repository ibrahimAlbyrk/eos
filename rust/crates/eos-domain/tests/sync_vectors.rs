//! The sync key, record names, sealed records and `stable_stringify` against
//! `tests/fixtures/sync-vectors.json`, written by the TypeScript sync code
//! (`spikes/data/ts/gen-sync-vectors.ts`) with an invented key.

#![allow(clippy::unwrap_used)]

use std::{fs, path::PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use eos_domain::sync::{OpenError, SyncKeys, content_hash, format_sync_key, parse_sync_key, stable_stringify};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    sync_key: String,
    relay_url: String,
    vault_id: String,
    auth_token: String,
    records: Vec<Record>,
    stable: Vec<Stable>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    domain: String,
    id: String,
    record_key: String,
    plaintext: String,
    sealed: String,
}

#[derive(Deserialize)]
struct Stable {
    json: String,
    stable: String,
    hash: String,
}

fn vectors() -> Vectors {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sync-vectors.json");
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn keys(v: &Vectors) -> SyncKeys {
    SyncKeys::derive(&parse_sync_key(&v.sync_key).unwrap().secret)
}

#[test]
fn the_key_parses_formats_and_derives_the_same_ids() {
    let v = vectors();
    let id = parse_sync_key(&v.sync_key).unwrap();
    assert_eq!(id.relay_url, v.relay_url);
    assert_eq!(format_sync_key(&id), v.sync_key);
    let keys = SyncKeys::derive(&id.secret);
    assert_eq!(keys.vault_id, v.vault_id);
    assert_eq!(keys.auth_token, v.auth_token);
}

#[test]
fn keys_that_typescript_rejects_are_rejected() {
    let v = vectors();
    let parts: Vec<&str> = v.sync_key.split('.').collect();
    assert!(parse_sync_key(&format!("  {}\n", v.sync_key)).is_some(), "surrounding whitespace is trimmed");
    assert!(parse_sync_key(&format!("eos-sync2.{}.{}", parts[1], parts[2])).is_none());
    assert!(parse_sync_key(&format!("{}.extra", v.sync_key)).is_none());
    assert!(parse_sync_key(&format!("eos-sync1.{}.{}", parts[1], &parts[2][..40])).is_none(), "short secret");
    assert!(parse_sync_key(&format!("eos-sync1.{}.{}", "ZnRwOi8veA", parts[2])).is_none(), "ftp://x");
}

#[test]
fn record_names_match() {
    let v = vectors();
    let keys = keys(&v);
    for r in &v.records {
        assert_eq!(keys.record_key(&r.domain, &r.id), r.record_key, "{}/{}", r.domain, r.id);
    }
}

#[test]
fn rust_opens_what_typescript_sealed() {
    let v = vectors();
    let keys = keys(&v);
    for r in &v.records {
        let sealed = STANDARD.decode(&r.sealed).unwrap();
        assert_eq!(keys.open(&r.record_key, &sealed).unwrap(), r.plaintext.as_bytes());
        let envelope: Value = serde_json::from_str(&r.plaintext).unwrap();
        assert_eq!(envelope["v"], 1);
        assert_eq!(envelope["domain"], r.domain.as_str());
    }
}

#[test]
fn sealing_with_typescripts_nonce_gives_typescripts_bytes() {
    let v = vectors();
    let keys = keys(&v);
    for r in &v.records {
        let sealed = STANDARD.decode(&r.sealed).unwrap();
        let nonce: [u8; 12] = sealed[..12].try_into().unwrap();
        assert_eq!(keys.seal(&r.record_key, r.plaintext.as_bytes(), &nonce), sealed);
    }
}

#[test]
fn a_record_opens_only_under_its_own_name_and_unchanged() {
    let v = vectors();
    let keys = keys(&v);
    let (a, b) = (&v.records[0], &v.records[1]);
    let sealed = keys.seal(&a.record_key, b"hello", &[7; 12]);
    assert_eq!(sealed.len(), 12 + 5 + 16);
    assert_eq!(keys.open(&a.record_key, &sealed).unwrap(), b"hello");
    assert_eq!(keys.open(&b.record_key, &sealed), Err(OpenError::NotAuthentic));
    let mut changed = sealed.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(keys.open(&a.record_key, &changed), Err(OpenError::NotAuthentic));
    assert_eq!(keys.open(&a.record_key, &sealed[..27]), Err(OpenError::TooShort));
    assert_ne!(keys.seal(&a.record_key, b"hello", &[8; 12]), sealed, "another nonce, other bytes");
}

#[test]
fn stable_stringify_and_its_hash_match_on_awkward_json() {
    let v = vectors();
    assert!(v.stable.len() >= 14);
    for s in &v.stable {
        let value: Value = serde_json::from_str(&s.json).unwrap();
        let text = stable_stringify(&value);
        assert_eq!(text, s.stable, "input: {}", s.json);
        assert_eq!(content_hash(&text), s.hash);
    }
}
