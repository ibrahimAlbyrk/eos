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
    crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature, verify_tls13_signature_with_raw_key},
    pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// How the handshake signature is checked against the peer's certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureCheck {
    /// rustls' own path: webpki parses the certificate and verifies.
    Webpki,
    /// The fallback if webpki ever refuses the hand-built certificate: take the
    /// SubjectPublicKeyInfo out with x509-parser and verify against the raw key.
    RawSpki,
}

fn check_signature(
    how: SignatureCheck,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
    algs: &WebPkiSupportedAlgorithms,
) -> Result<HandshakeSignatureValid, Error> {
    match how {
        SignatureCheck::Webpki => verify_tls13_signature(message, cert, dss, algs),
        SignatureCheck::RawSpki => {
            let (_, parsed) = x509_parser::parse_x509_certificate(cert)
                .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
            let spki = SubjectPublicKeyInfoDer::from(parsed.tbs_certificate.subject_pki.raw);
            verify_tls13_signature_with_raw_key(message, &spki, dss, algs)
        }
    }
}

fn tls12_is_off() -> Error {
    Error::General("the peer channel is TLS 1.3 only".into())
}

/// Client side: the server must present exactly the pinned certificate.
#[derive(Debug)]
pub struct PinnedServer {
    expected: [u8; 32],
    algs: WebPkiSupportedAlgorithms,
    how: SignatureCheck,
}

impl PinnedServer {
    pub fn new(
        expected_fingerprint_hex: &str,
        provider: &CryptoProvider,
        how: SignatureCheck,
    ) -> anyhow::Result<Arc<Self>> {
        let expected: [u8; 32] = hex::decode(expected_fingerprint_hex)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("a fingerprint is 32 bytes of hex"))?;
        Ok(Arc::new(Self { expected, algs: provider.signature_verification_algorithms, how }))
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
        if bool::from(actual.as_slice().ct_eq(&self.expected)) {
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
        check_signature(self.how, message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// Server side: any certificate completes the handshake (its key is proven by
/// the signature); who it is — trusted, pairing-only, refused — is decided
/// from its fingerprint right after, as the TypeScript host does.
#[derive(Debug)]
pub struct AnyProvenClient {
    algs: WebPkiSupportedAlgorithms,
    how: SignatureCheck,
}

impl AnyProvenClient {
    pub fn new(provider: &CryptoProvider, how: SignatureCheck) -> Arc<Self> {
        Arc::new(Self { algs: provider.signature_verification_algorithms, how })
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
        check_signature(self.how, message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}
