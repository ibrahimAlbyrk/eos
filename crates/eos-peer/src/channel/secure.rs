//! Connect and accept over any byte stream — a TCP socket, the relay pipe or
//! an HTTP/2 stream (the reverse tunnel): TLS 1.3, ALPN `h2`, both ends
//! present their identity, the dialer pins the host.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::version::TLS13;
use rustls::{CertificateError, ClientConfig, ServerConfig};
use tokio_rustls::{TlsAcceptor, TlsConnector, client, server};

use super::BoxIo;
use super::pin::{AnyProvenClient, PinnedServer};
use crate::Error;
use crate::identity::{self, Identity};

/// How long a peer gets to finish the handshake on the accepting side.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a dial did not produce a channel.
#[derive(Debug)]
pub(crate) enum ConnectError {
    /// Whoever answered is not the pinned computer.
    IdentityMismatch,
    TimedOut,
    Io(io::Error),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdentityMismatch => f.write_str("peer identity mismatch"),
            Self::TimedOut => f.write_str("tls handshake timed out"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

fn is_pin_failure(e: &io::Error) -> bool {
    matches!(
        e.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()),
        Some(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
    )
}

/// This computer's end of the channel.
pub(crate) struct Channel {
    identity: Arc<Identity>,
    acceptor: TlsAcceptor,
}

impl std::fmt::Debug for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Channel").field("identity", &self.identity).finish_non_exhaustive()
    }
}

impl Channel {
    pub(crate) fn new(identity: Arc<Identity>) -> Result<Self, Error> {
        let verifier = AnyProvenClient::new(&identity.provider);
        let mut config = ServerConfig::builder_with_provider(identity.provider.clone())
            .with_protocol_versions(&[&TLS13])
            .map_err(|e| Error::Tls(e.to_string()))?
            .with_client_cert_verifier(verifier)
            .with_single_cert(vec![identity.cert.clone()], identity.key.clone_key())
            .map_err(|e| Error::Tls(e.to_string()))?;
        config.alpn_protocols = vec![b"h2".to_vec()];
        Ok(Self { identity, acceptor: TlsAcceptor::from(Arc::new(config)) })
    }

    pub(crate) fn fingerprint(&self) -> &str {
        self.identity.fingerprint()
    }

    /// Resolves only after the other end proved the pinned identity; nothing
    /// is sent to an unverified peer.
    pub(crate) async fn connect(
        &self,
        io: BoxIo,
        expect_fingerprint: &str,
        timeout: Duration,
    ) -> Result<client::TlsStream<BoxIo>, ConnectError> {
        let verifier = PinnedServer::new(expect_fingerprint, &self.identity.provider)
            .ok_or_else(|| ConnectError::Io(other("not a certificate fingerprint")))?;
        let mut config = ClientConfig::builder_with_provider(self.identity.provider.clone())
            .with_protocol_versions(&[&TLS13])
            .map_err(|e| ConnectError::Io(other(e)))?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_auth_cert(vec![self.identity.cert.clone()], self.identity.key.clone_key())
            .map_err(|e| ConnectError::Io(other(e)))?;
        config.alpn_protocols = vec![b"h2".to_vec()];
        // The TypeScript dialer sends no server name; nothing on either side reads one.
        config.enable_sni = false;
        let name = ServerName::try_from("eos-peer").map_err(|e| ConnectError::Io(other(e)))?;
        let handshake = TlsConnector::from(Arc::new(config)).connect(name, io);
        let stream = match tokio::time::timeout(timeout, handshake).await {
            Err(_) => return Err(ConnectError::TimedOut),
            Ok(Err(e)) if is_pin_failure(&e) => return Err(ConnectError::IdentityMismatch),
            Ok(Err(e)) => return Err(ConnectError::Io(e)),
            Ok(Ok(stream)) => stream,
        };
        if stream.get_ref().1.alpn_protocol() != Some(b"h2") {
            return Err(ConnectError::Io(other("peer did not negotiate h2")));
        }
        Ok(stream)
    }

    /// Completes the handshake with whoever dials and says who it is;
    /// admission is the caller's decision.
    pub(crate) async fn accept(&self, io: BoxIo) -> io::Result<(server::TlsStream<BoxIo>, String)> {
        let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, self.acceptor.accept(io))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "tls handshake timed out"))??;
        let conn = stream.get_ref().1;
        if conn.alpn_protocol() != Some(b"h2") {
            return Err(other("peer did not negotiate h2"));
        }
        let cert = conn.peer_certificates().and_then(|c| c.first()).ok_or_else(|| other("no certificate"))?;
        let fingerprint = identity::fingerprint(cert);
        Ok((stream, fingerprint))
    }
}
