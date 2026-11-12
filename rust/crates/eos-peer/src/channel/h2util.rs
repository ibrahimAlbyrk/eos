//! The little HTTP/2 the link needs on top of `h2`: both windows opened wide,
//! a body sent under flow control, a body read with its bytes given back to
//! the window.

use std::future::poll_fn;

use bytes::Bytes;
use h2::{RecvStream, SendStream, client, server};
use tokio::io::{AsyncRead, AsyncWrite};

use super::PEER_WINDOW_BYTES;

/// Largest piece handed to h2 at once; it frames and schedules from there.
const MAX_PIECE: usize = 256 * 1024;
/// How many requests one paired computer may have open at once (a dashboard
/// keeps a handful of event streams and a few requests); more wait on its side.
const MAX_STREAMS_PER_SESSION: u32 = 256;

pub(crate) async fn client_handshake<IO>(
    io: IO,
) -> Result<(client::SendRequest<Bytes>, client::Connection<IO, Bytes>), h2::Error>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    client::Builder::new()
        .initial_window_size(PEER_WINDOW_BYTES)
        .initial_connection_window_size(PEER_WINDOW_BYTES)
        .handshake(io)
        .await
}

pub(crate) async fn server_handshake<IO>(io: IO) -> Result<server::Connection<IO, Bytes>, h2::Error>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    server::Builder::new()
        .max_concurrent_streams(MAX_STREAMS_PER_SESSION)
        .initial_window_size(PEER_WINDOW_BYTES)
        .initial_connection_window_size(PEER_WINDOW_BYTES)
        .handshake(io)
        .await
}

/// Sends all of `data`, waiting for window as needed.
pub(crate) async fn send_all(stream: &mut SendStream<Bytes>, mut data: Bytes) -> Result<(), h2::Error> {
    while !data.is_empty() {
        stream.reserve_capacity(data.len().min(MAX_PIECE));
        let granted = match poll_fn(|cx| stream.poll_capacity(cx)).await {
            Some(n) => n?,
            None => return Err(h2::Reason::CANCEL.into()),
        };
        let piece = data.split_to(granted.min(data.len()));
        stream.send_data(piece, false)?;
    }
    Ok(())
}

/// Ends the stream on this side.
pub(crate) fn finish(stream: &mut SendStream<Bytes>) -> Result<(), h2::Error> {
    stream.send_data(Bytes::new(), true)
}

/// The next piece of a body, its bytes already given back to the window;
/// `None` at the end.
pub(crate) async fn next_chunk(body: &mut RecvStream) -> Option<Result<Bytes, h2::Error>> {
    let chunk = body.data().await?;
    Some(chunk.and_then(|chunk| {
        body.flow_control().release_capacity(chunk.len())?;
        Ok(chunk)
    }))
}

/// A whole body, or `None` once it grows past `limit` bytes.
pub(crate) async fn read_up_to(body: &mut RecvStream, limit: usize) -> Result<Option<Bytes>, h2::Error> {
    let mut out = Vec::new();
    while let Some(chunk) = next_chunk(body).await {
        let chunk = chunk?;
        if out.len() + chunk.len() > limit {
            return Ok(None);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Some(out.into()))
}
