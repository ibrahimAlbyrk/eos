//! This computer's identity as Eos stores it under `<home>/peer/`:
//! `device.key` (PKCS#8, ECDSA P-256) and `device.crt` (the self-signed
//! certificate). The fingerprint — SHA-256 over the certificate's DER, in
//! lower-case hex — is the computer's id on every paired computer, so the
//! files are minted once and never replaced.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};

use crate::Error;
use crate::stores::write_secret;
use crate::x509;

const KEY_FILE: &str = "device.key";
const CERT_FILE: &str = "device.crt";

pub struct Identity {
    pub(crate) cert: CertificateDer<'static>,
    pub(crate) key: PrivateKeyDer<'static>,
    pub(crate) provider: Arc<CryptoProvider>,
    fingerprint: String,
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
    /// Reads the identity in `peer_dir`, or mints one there when the folder
    /// holds none. Files that exist but cannot be read are an error, never
    /// overwritten.
    pub fn load_or_create(peer_dir: &Path, now_ms: i64) -> Result<Self, Error> {
        let (key_path, cert_path) = (peer_dir.join(KEY_FILE), peer_dir.join(CERT_FILE));
        if key_path.exists() && cert_path.exists() {
            let key = fs::read_to_string(&key_path).map_err(|e| Error::io(&key_path, e))?;
            let cert = fs::read_to_string(&cert_path).map_err(|e| Error::io(&cert_path, e))?;
            return Self::from_pem(&key, &cert)
                .map_err(|reason| Error::BadIdentity { dir: peer_dir.to_owned(), reason });
        }
        let (key, cert) = x509::create_self_signed(now_ms)?;
        write_secret(&key_path, key.as_bytes())?;
        write_secret(&cert_path, cert.as_bytes())?;
        Self::from_pem(&key, &cert).map_err(Error::KeyGeneration)
    }

    fn from_pem(key_pem: &str, cert_pem: &str) -> Result<Self, String> {
        let cert = CertificateDer::from_pem_slice(cert_pem.as_bytes()).map_err(|e| format!("device.crt: {e}"))?;
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).map_err(|e| format!("device.key: {e}"))?;
        let fingerprint = fingerprint(&cert);
        Ok(Self { cert, key, provider: Arc::new(rustls::crypto::aws_lc_rs::default_provider()), fingerprint })
    }

    /// The computer's id: 64 lower-case hex characters.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}
