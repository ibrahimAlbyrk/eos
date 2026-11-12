use eos_core::Error;
use eos_core::net::sync::SyncCrypto;
use eos_domain::sync::key::{NONCE_BYTES, SECRET_BYTES};
use eos_domain::sync::{SyncIdentity, SyncKeys, content_hash};

/// Random bytes from the system. A system without randomness cannot seal
/// anything safely, so that is a stop, not an error to carry on from.
fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random source");
    bytes
}

/// A new account on `relay_url`: a fresh 32-byte secret.
pub fn new_identity(relay_url: &str) -> SyncIdentity {
    SyncIdentity { relay_url: relay_url.to_owned(), secret: random::<SECRET_BYTES>() }
}

/// The crypto of one sync key.
#[derive(Debug)]
pub struct VaultCrypto(SyncKeys);

impl VaultCrypto {
    pub fn new(keys: SyncKeys) -> Self {
        Self(keys)
    }
}

impl SyncCrypto for VaultCrypto {
    fn record_key(&self, domain: &str, id: &str) -> String {
        self.0.record_key(domain, id)
    }

    fn seal(&self, record_key: &str, plaintext: &[u8]) -> Vec<u8> {
        self.0.seal(record_key, plaintext, &random::<NONCE_BYTES>())
    }

    fn open(&self, record_key: &str, sealed: &[u8]) -> Result<Vec<u8>, Error> {
        self.0.open(record_key, sealed).map_err(|e| Error::Rule(e.to_string()))
    }

    fn hash(&self, text: &str) -> String {
        content_hash(text)
    }
}
