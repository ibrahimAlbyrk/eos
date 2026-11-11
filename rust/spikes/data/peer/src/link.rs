//! Connect and accept over any byte stream — a TCP socket, the relay pipe or an
//! HTTP/2 stream (the reverse tunnel) — the way secure-channel.ts does: TLS 1.3,
//! ALPN `h2`, both ends present their identity, the dialer pins the host.

use std::{io, sync::Arc};

use rustls::{ClientConfig, ServerConfig, crypto::ring, pki_types::ServerName, version::TLS13};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::{TlsAcceptor, TlsConnector, client, server};

use crate::{
    identity::{self, Identity},
    pin::{AnyProvenClient, PinnedServer, SignatureCheck},
};

fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

/// Resolves only after the server proved the pinned identity.
pub async fn connect_secure<IO>(
    io: IO,
    me: &Identity,
    expect_fingerprint: &str,
    how: SignatureCheck,
) -> io::Result<client::TlsStream<IO>>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let provider = Arc::new(ring::default_provider());
    let verifier = PinnedServer::new(expect_fingerprint, &provider, how).map_err(other)?;
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])
        .map_err(other)?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(vec![me.cert.clone()], me.clone_key())
        .map_err(other)?;
    config.alpn_protocols = vec![b"h2".to_vec()];
    // The TypeScript dialer sends no server name; nothing on either side reads one.
    config.enable_sni = false;
    let name = ServerName::try_from("eos-peer").map_err(other)?;
    let stream = TlsConnector::from(Arc::new(config)).connect(name, io).await?;
    if stream.get_ref().1.alpn_protocol() != Some(b"h2") {
        return Err(other("peer did not negotiate h2"));
    }
    Ok(stream)
}

/// Completes the handshake with whoever dials and says who it is; admission is
/// the caller's decision.
pub async fn accept_secure<IO>(
    io: IO,
    me: &Identity,
    how: SignatureCheck,
) -> io::Result<(server::TlsStream<IO>, String)>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let provider = Arc::new(ring::default_provider());
    let verifier = AnyProvenClient::new(&provider, how);
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])
        .map_err(other)?
        .with_client_cert_verifier(verifier)
        .with_single_cert(vec![me.cert.clone()], me.clone_key())
        .map_err(other)?;
    config.alpn_protocols = vec![b"h2".to_vec()];
    let stream = TlsAcceptor::from(Arc::new(config)).accept(io).await?;
    let conn = stream.get_ref().1;
    if conn.alpn_protocol() != Some(b"h2") {
        return Err(other("peer did not negotiate h2"));
    }
    let cert = conn.peer_certificates().and_then(|c| c.first()).ok_or_else(|| other("no certificate"))?;
    let fingerprint = identity::fingerprint(cert);
    Ok((stream, fingerprint))
}
