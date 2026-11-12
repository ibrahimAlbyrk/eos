//! Certificate verification for the peer channel: identity is the certificate's
//! fingerprint and nothing else (Syncthing's model). A verifier here
//!
//! - never builds a chain, checks a name, a date, a key usage or an extension —
//!   the certificates carry none and are valid until year 9999;
//! - still verifies the handshake signature with the certificate's public key,
//!   which is what proves the peer holds the private key of the pinned cert;
//! - accepts TLS 1.3 only.

use std::sync::Arc;

use rustls::{
    CertificateError, DigitallySignedStruct, DistinguishedName, Error, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use sha2::{Digest, Sha256};

fn tls12_is_off() -> Error {
    Error::General("the peer channel is TLS 1.3 only".into())
}

/// Client side: the server must present exactly the pinned certificate.
#[derive(Debug)]
pub(crate) struct PinnedServer {
    expected: [u8; 32],
    algs: WebPkiSupportedAlgorithms,
}

impl PinnedServer {
    /// `None` when `expected_fingerprint_hex` is not 32 bytes of hex.
    pub(crate) fn new(expected_fingerprint_hex: &str, provider: &CryptoProvider) -> Option<Arc<Self>> {
        let expected: [u8; 32] = hex::decode(expected_fingerprint_hex).ok()?.try_into().ok()?;
        Some(Arc::new(Self { expected, algs: provider.signature_verification_algorithms }))
    }
}

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let actual = Sha256::digest(end_entity);
        // Every byte is compared, wherever the first difference is.
        if actual.iter().zip(&self.expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(tls12_is_off())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// Server side: any certificate completes the handshake (its key is proven by
/// the signature); who it is — trusted, pairing-only, refused — is decided
/// from its fingerprint right after, as the TypeScript host does.
#[derive(Debug)]
pub(crate) struct AnyProvenClient {
    algs: WebPkiSupportedAlgorithms,
}

impl AnyProvenClient {
    pub(crate) fn new(provider: &CryptoProvider) -> Arc<Self> {
        Arc::new(Self { algs: provider.signature_verification_algorithms })
    }
}

impl ClientCertVerifier for AnyProvenClient {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(tls12_is_off())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}
