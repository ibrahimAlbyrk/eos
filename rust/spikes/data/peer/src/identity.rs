//! A peer identity as Eos stores it: `key.pem` (PKCS#8, ECDSA P-256) and
//! `cert.pem` (hand-built self-signed X.509 v3, CN only, no extensions, valid to
//! 9999-12-31). The files are reused as they are — never regenerated.

use std::path::Path;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use sha2::{Digest, Sha256};

pub struct Identity {
    pub cert: CertificateDer<'static>,
    pub key: PrivateKeyDer<'static>,
    /// sha256 over the certificate's DER, lowercase hex — the device's id.
    pub fingerprint: String,
}

// Key material never reaches a log.
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity").field("fingerprint", &self.fingerprint).finish_non_exhaustive()
    }
}

pub fn fingerprint(cert_der: &[u8]) -> String {
    hex::encode(Sha256::digest(cert_der))
}

impl Identity {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let cert = CertificateDer::from_pem_file(dir.join("cert.pem"))?;
        let key = PrivateKeyDer::from_pem_file(dir.join("key.pem"))?;
        let fingerprint = fingerprint(&cert);
        Ok(Self { cert, key, fingerprint })
    }

    pub fn clone_key(&self) -> PrivateKeyDer<'static> {
        self.key.clone_key()
    }
}
