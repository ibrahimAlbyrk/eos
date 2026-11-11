//! The little HTTP/2 the demos need on top of `h2`: open both windows wide,
//! send a request with a body under flow control, read a body to the end.

use std::future::poll_fn;

use bytes::Bytes;
use h2::{RecvStream, SendStream, client, server};
use http::{Method, Request};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::PEER_WINDOW_BYTES;

pub async fn client_handshake<IO>(
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

pub async fn server_handshake<IO>(io: IO) -> Result<server::Connection<IO, Bytes>, h2::Error>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    server::Builder::new()
        .initial_window_size(PEER_WINDOW_BYTES)
        .initial_connection_window_size(PEER_WINDOW_BYTES)
        .handshake(io)
        .await
}

/// Sends all of `data`, waiting for window as needed; `end` closes the stream.
pub async fn send_all(stream: &mut SendStream<Bytes>, mut data: Bytes, end: bool) -> Result<(), h2::Error> {
    while !data.is_empty() {
        stream.reserve_capacity(data.len());
        let granted = match poll_fn(|cx| stream.poll_capacity(cx)).await {
            Some(n) => n?,
            None => return Err(h2::Reason::CANCEL.into()),
        };
        let piece = data.split_to(granted.min(data.len()));
        stream.send_data(piece, false)?;
    }
    if end {
        stream.send_data(Bytes::new(), true)?;
    }
    Ok(())
}

pub async fn read_all(body: &mut RecvStream) -> Result<Vec<u8>, h2::Error> {
    let mut out = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk?;
        body.flow_control().release_capacity(chunk.len())?;
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// One request, whole body out, whole body back.
pub async fn request(
    sender: &mut client::SendRequest<Bytes>,
    method: Method,
    path: &str,
    body: Bytes,
) -> anyhow::Result<(u16, Vec<u8>)> {
    let req = Request::builder().method(method).uri(format!("https://eos-peer{path}")).body(())?;
    let mut ready = sender.clone().ready().await?;
    let (response, mut stream) = ready.send_request(req, false)?;
    send_all(&mut stream, body, true).await?;
    let response = response.await?;
    let status = response.status().as_u16();
    let bytes = read_all(&mut response.into_body()).await?;
    Ok((status, bytes))
}
