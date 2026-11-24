//! The byte format the relay seals hook events in (07 §4.7), the same as
//! `relay/hooks/seal.ts`: an ephemeral X25519 key, HKDF-SHA256 of the shared
//! secret (empty salt, info `eos-hook-seal-v1`) to an AES-256-GCM key, and
//! `ephemeral public 32 ‖ nonce 12 ‖ ciphertext ‖ tag 16`. Vectors in
//! `fixtures/relay/hook-seal.json` hold both sides to it.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const INFO: &[u8] = b"eos-hook-seal-v1";
const HEAD: usize = 32 + 12;
const TAG: usize = 16;

/// The public key the relay seals to, for `secret`.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

fn cipher(secret: &StaticSecret, other: &[u8; 32]) -> Aes256Gcm {
    let shared = secret.diffie_hellman(&PublicKey::from(*other));
    let mut key = [0u8; 32];
    // 32 bytes is far below HKDF-SHA256's limit.
    let _ = Hkdf::<Sha256>::new(None, shared.as_bytes()).expand(INFO, &mut key);
    Aes256Gcm::new(&key.into())
}

/// The plaintext of `sealed`; `None` when it was not sealed to `secret` or
/// was changed on the way.
pub fn open(secret: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < HEAD + TAG {
        return None;
    }
    let ephemeral: [u8; 32] = sealed[..32].try_into().ok()?;
    let nonce: [u8; 12] = sealed[32..HEAD].try_into().ok()?;
    cipher(&StaticSecret::from(*secret), &ephemeral).decrypt(&Nonce::from(nonce), &sealed[HEAD..]).ok()
}

/// Seals `plaintext` to `recipient` with the given ephemeral secret and
/// nonce, as the relay does with fresh ones. The fake relay seals with it.
pub fn seal(recipient: &[u8; 32], plaintext: &[u8], ephemeral: [u8; 32], nonce: [u8; 12]) -> Vec<u8> {
    let ephemeral = StaticSecret::from(ephemeral);
    let mut sealed = PublicKey::from(&ephemeral).to_bytes().to_vec();
    sealed.extend_from_slice(&nonce);
    // AES-GCM encrypts any message the relay takes (1 MiB and its JSON).
    let body = cipher(&ephemeral, recipient).encrypt(&Nonce::from(nonce), plaintext).unwrap_or_default();
    sealed.extend_from_slice(&body);
    sealed
}
