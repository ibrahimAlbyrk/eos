//! The sync key and everything derived from it.
//!
//! key      = "eos-sync1." base64url(relayUrl) "." base64url(32-byte secret)
//! derive   = HKDF-SHA256(ikm = secret, salt = "eos-sync-v1", info = label)
//!            labels: "enc" (32), "record-key" (32), "vault-id" (16), "auth" (32)
//! name     = hex(HMAC-SHA256(record-key, domain ‖ 0x00 ‖ id))
//! record   = nonce(12) ‖ AES-256-GCM(enc, nonce, aad = name as ASCII) ‖ tag(16)

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const KEY_PREFIX: &str = "eos-sync1";
const SECRET_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const SALT: &[u8] = b"eos-sync-v1";

#[derive(Clone, PartialEq, Eq)]
pub struct SyncIdentity {
    pub relay_url: String,
    pub secret: [u8; SECRET_BYTES],
}

// The secret never reaches a log.
impl std::fmt::Debug for SyncIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncIdentity").field("relay_url", &self.relay_url).finish_non_exhaustive()
    }
}

pub fn format_sync_key(id: &SyncIdentity) -> String {
    format!("{KEY_PREFIX}.{}.{}", URL_SAFE_NO_PAD.encode(&id.relay_url), URL_SAFE_NO_PAD.encode(id.secret))
}

pub fn parse_sync_key(key: &str) -> Option<SyncIdentity> {
    let mut parts = key.trim().split('.');
    let (prefix, url, secret) = (parts.next()?, parts.next()?, parts.next()?);
    if prefix != KEY_PREFIX || url.is_empty() || secret.is_empty() || parts.next().is_some() {
        return None;
    }
    let relay_url = String::from_utf8(URL_SAFE_NO_PAD.decode(url).ok()?).ok()?;
    let secret: [u8; SECRET_BYTES] = URL_SAFE_NO_PAD.decode(secret).ok()?.try_into().ok()?;
    let scheme_ok = ["ws://", "wss://", "http://", "https://"]
        .iter()
        .any(|s| relay_url.strip_prefix(s).is_some_and(|rest| !rest.is_empty() && !rest.contains(char::is_whitespace)));
    scheme_ok.then_some(SyncIdentity { relay_url, secret })
}

pub struct SyncKeys {
    pub vault_id: String,
    pub auth_token: String,
    enc: [u8; 32],
    name: [u8; 32],
}

impl std::fmt::Debug for SyncKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncKeys").field("vault_id", &self.vault_id).finish_non_exhaustive()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    TooShort,
    /// Wrong key, wrong record name, or a changed blob.
    NotAuthentic,
}

impl SyncKeys {
    pub fn derive(secret: &[u8]) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(SALT), secret);
        let expand =
            |label: &str, out: &mut [u8]| hk.expand(label.as_bytes(), out).expect("length within HKDF's limit");
        let (mut enc, mut name, mut vault, mut auth) = ([0u8; 32], [0u8; 32], [0u8; 16], [0u8; 32]);
        expand("enc", &mut enc);
        expand("record-key", &mut name);
        expand("vault-id", &mut vault);
        expand("auth", &mut auth);
        Self { vault_id: hex::encode(vault), auth_token: URL_SAFE_NO_PAD.encode(auth), enc, name }
    }

    /// The name the relay knows a record by.
    pub fn record_key(&self, domain: &str, id: &str) -> String {
        let mut mac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(&self.name).expect("any key length");
        mac.update(domain.as_bytes());
        mac.update(&[0]);
        mac.update(id.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    pub fn seal(&self, record_key: &str, plaintext: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).expect("system randomness");
        self.seal_with_nonce(record_key, plaintext, &nonce)
    }

    /// `seal` with the nonce given — only so a test can reproduce another
    /// implementation's bytes. A nonce must never repeat under one key.
    pub fn seal_with_nonce(&self, record_key: &str, plaintext: &[u8], nonce: &[u8; NONCE_BYTES]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(&self.enc).expect("32-byte key");
        let body = cipher
            .encrypt(&Nonce::from(*nonce), Payload { msg: plaintext, aad: record_key.as_bytes() })
            .expect("AES-GCM encrypts any message of this size");
        let mut out = Vec::with_capacity(NONCE_BYTES + body.len());
        out.extend_from_slice(nonce);
        out.extend_from_slice(&body); // ciphertext ‖ tag
        out
    }

    pub fn open(&self, record_key: &str, sealed: &[u8]) -> Result<Vec<u8>, OpenError> {
        if sealed.len() < NONCE_BYTES + TAG_BYTES {
            return Err(OpenError::TooShort);
        }
        let (nonce, body) = sealed.split_at(NONCE_BYTES);
        let nonce: [u8; NONCE_BYTES] = nonce.try_into().expect("split at 12");
        let cipher = Aes256Gcm::new_from_slice(&self.enc).expect("32-byte key");
        cipher
            .decrypt(&Nonce::from(nonce), Payload { msg: body, aad: record_key.as_bytes() })
            .map_err(|_| OpenError::NotAuthentic)
    }
}

/// Content fingerprint for change detection (not secret).
pub fn content_hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}
