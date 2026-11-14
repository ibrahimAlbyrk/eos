//! The update feed's signature: Ed25519 over the pointer's JSON, verbatim.
//! Public keys travel as their JWK `x` (base64url of the 32 raw bytes); more
//! than one is accepted so a key can be rotated without stranding old installs.
//! The private key is PKCS#8 DER in base64 — what the release Mac keeps in its
//! Keychain.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use eos_contracts::update::UPDATE_PUBLIC_KEYS;
use eos_core::net::updates::UpdateSignature;

use crate::error::Error;

/// The keys whose signature on a pointer is trusted.
#[derive(Debug, Clone)]
pub struct Ed25519Keys {
    keys: Vec<VerifyingKey>,
}

impl Ed25519Keys {
    pub fn new(public_keys: &[&str]) -> Result<Self, Error> {
        let keys = public_keys.iter().map(|x| verifying_key(x)).collect::<Result<_, _>>()?;
        Ok(Self { keys })
    }

    /// The keys compiled into the app (`UPDATE_PUBLIC_KEYS`).
    pub fn trusted() -> Result<Self, Error> {
        Self::new(UPDATE_PUBLIC_KEYS)
    }
}

fn verifying_key(jwk_x: &str) -> Result<VerifyingKey, Error> {
    let raw: [u8; 32] = URL_SAFE_NO_PAD
        .decode(jwk_x)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| Error::Key("a public key is 32 bytes in base64url".into()))?;
    VerifyingKey::from_bytes(&raw).map_err(|_| Error::Key("a public key is not a point on the curve".into()))
}

impl UpdateSignature for Ed25519Keys {
    fn verify(&self, payload: &str, signature: &str) -> bool {
        let Ok(bytes) = STANDARD.decode(signature) else { return false };
        let Ok(signature) = Signature::from_slice(&bytes) else { return false };
        self.keys.iter().any(|key| key.verify(payload.as_bytes(), &signature).is_ok())
    }
}

fn signing_key(private_key: &str) -> Result<SigningKey, Error> {
    let der = STANDARD.decode(private_key.trim()).map_err(|_| Error::Key("the signing key is not base64".into()))?;
    SigningKey::from_pkcs8_der(&der).map_err(|_| Error::Key("the signing key is not an Ed25519 key in PKCS#8".into()))
}

/// Signs a pointer payload; the result is what the wrapper's `signature` holds.
pub fn sign_payload(payload: &str, private_key: &str) -> Result<String, Error> {
    Ok(STANDARD.encode(signing_key(private_key)?.sign(payload.as_bytes()).to_bytes()))
}

/// The public half of a private key (its JWK `x`), to check it is one the app trusts.
pub fn public_key_of(private_key: &str) -> Result<String, Error> {
    Ok(URL_SAFE_NO_PAD.encode(signing_key(private_key)?.verifying_key().to_bytes()))
}

#[cfg(test)]
mod tests {
    use eos_contracts::update::SignedUpdatePointer;
    use eos_testkit::update::{read, release};

    use super::*;

    /// A second throwaway key (PKCS#8 = the fixed prefix + a 32-byte seed).
    fn other_key() -> String {
        let mut der =
            vec![0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
        der.extend_from_slice(&[7u8; 32]);
        STANDARD.encode(der)
    }

    #[test]
    fn a_key_verifies_what_it_signed_and_nothing_else() {
        let rel = release();
        assert_eq!(public_key_of(&rel.private_key).expect("key"), rel.public_key);
        let other_public = public_key_of(&other_key()).expect("key");
        let payload = r#"{"version":"0.1.3"}"#;
        let signature = sign_payload(payload, &rel.private_key).expect("signed");
        assert_eq!(signature.len(), 88, "64 bytes in padded base64, as the wrapper's schema demands");

        let keys = |list: &[&str]| Ed25519Keys::new(list).expect("keys");
        assert!(keys(&[&rel.public_key]).verify(payload, &signature));
        assert!(!keys(&[&rel.public_key]).verify(r#"{"version":"9.9.9"}"#, &signature));
        assert!(!keys(&[&other_public]).verify(payload, &signature));
        assert!(keys(&[&other_public, &rel.public_key]).verify(payload, &signature));
        assert!(!keys(&[&rel.public_key]).verify(payload, "not base64"));
        assert!(!keys(&[&rel.public_key]).verify(payload, "AAAA"));
    }

    #[test]
    fn a_pointer_signed_by_typescript_verifies_and_a_changed_one_does_not() {
        let rel = release();
        let keys = Ed25519Keys::new(&[&rel.public_key]).expect("keys");
        for version in ["9.0.0", "9.0.1"] {
            let signed: SignedUpdatePointer =
                serde_json::from_slice(&read(&format!("pointer-{version}.json"))).expect("pointer");
            assert!(keys.verify(&signed.payload, &signed.signature));
            // Ed25519 signatures are deterministic: signing here gives TypeScript's bytes.
            assert_eq!(sign_payload(&signed.payload, &rel.private_key).expect("signed"), signed.signature);
            let mut tampered = signed.payload.clone().into_bytes();
            tampered[10] ^= 1;
            assert!(!keys.verify(std::str::from_utf8(&tampered).expect("ascii"), &signed.signature));
        }
        assert!(Ed25519Keys::trusted().is_ok(), "the keys compiled into the app parse");
    }

    #[test]
    fn a_malformed_key_is_refused_with_its_reason() {
        assert!(matches!(Ed25519Keys::new(&["short"]), Err(Error::Key(_))));
        assert!(matches!(sign_payload("{}", "AAAA"), Err(Error::Key(_))));
    }
}
