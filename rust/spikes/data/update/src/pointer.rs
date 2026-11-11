//! The signed pointer: `{ payload, signature }`, Ed25519 over the payload string
//! verbatim. Public keys travel as their JWK `x` (base64url of the 32 raw bytes);
//! the private key is PKCS#8 DER in base64.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, pkcs8::DecodePrivateKey};
use serde::{Deserialize, Serialize};

use crate::manifest::UpdatePointer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedUpdatePointer {
    pub payload: String,
    pub signature: String,
}

pub fn verifying_key(jwk_x: &str) -> anyhow::Result<VerifyingKey> {
    let raw: [u8; 32] =
        URL_SAFE_NO_PAD.decode(jwk_x)?.try_into().map_err(|_| anyhow::anyhow!("a public key is 32 bytes"))?;
    Ok(VerifyingKey::from_bytes(&raw)?)
}

/// True when any trusted key signed exactly these payload bytes.
pub fn verify(payload: &str, signature_b64: &str, keys: &[VerifyingKey]) -> bool {
    let Ok(sig) = STANDARD.decode(signature_b64) else { return false };
    let Ok(sig) = Signature::from_slice(&sig) else { return false };
    keys.iter().any(|key| key.verify(payload.as_bytes(), &sig).is_ok())
}

pub fn sign(payload: &str, private_key_pkcs8_b64: &str) -> anyhow::Result<String> {
    let key = SigningKey::from_pkcs8_der(&STANDARD.decode(private_key_pkcs8_b64)?)
        .map_err(|e| anyhow::anyhow!("private key: {e}"))?;
    Ok(STANDARD.encode(key.sign(payload.as_bytes()).to_bytes()))
}

/// Checks the signature, then parses what was signed.
pub fn open(signed: &SignedUpdatePointer, keys: &[VerifyingKey]) -> anyhow::Result<UpdatePointer> {
    anyhow::ensure!(
        verify(&signed.payload, &signed.signature, keys),
        "the pointer's signature is not from a trusted key"
    );
    Ok(serde_json::from_str(&signed.payload)?)
}
