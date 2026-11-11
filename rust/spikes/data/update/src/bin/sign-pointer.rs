//! Signs a pointer with a key made on the spot and prints `{ publicKey, payload,
//! signature }` for ts/verify-pointer.ts: the TypeScript verifier must accept
//! what Rust signed.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{SigningKey, pkcs8::EncodePrivateKey};
use serde_json::json;
use spike_update::{
    manifest::{ManifestRef, UpdatePointer},
    pointer,
};

fn main() -> anyhow::Result<()> {
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut seed))?;
    let key = SigningKey::from_bytes(&seed);
    let pkcs8 = base64::engine::general_purpose::STANDARD
        .encode(key.to_pkcs8_der().map_err(|e| anyhow::anyhow!("{e}"))?.as_bytes());

    let ptr = UpdatePointer {
        version: "9.1.0".into(),
        platform: "darwin-arm64".into(),
        manifest: ManifestRef {
            path: "releases/9.1.0/darwin-arm64.manifest.json.zst".into(),
            sha256: "ab".repeat(32),
            size: 1234,
        },
        notes: None,
        released_at: "2026-11-11T00:00:00.000Z".into(),
        feed_url: None,
    };
    let payload = serde_json::to_string(&ptr)?;
    let signature = pointer::sign(&payload, &pkcs8)?;
    let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    println!("{}", json!({ "publicKey": public_key, "payload": payload, "signature": signature }));
    Ok(())
}
