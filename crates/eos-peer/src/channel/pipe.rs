//! One HTTP/2 stream as a duplex byte pipe — the reverse tunnel's transport.
//! The device POSTs `/peer/reverse`; after the host's 200 the stream's two
//! bodies carry TLS + HTTP/2 the other way. Flow control stays HTTP/2's:
//! a write waits for send capacity, a read gives its bytes back to the window.

use std::{
    io,
    pin::Pin,
    task::{Context, Poll, ready},
};

use bytes::{Buf, Bytes};
use h2::{RecvStream, SendStream};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Largest piece handed to h2 at once; it frames and schedules from there.
const MAX_WRITE: usize = 256 * 1024;

#[derive(Debug)]
pub(crate) struct H2Pipe {
    send: SendStream<Bytes>,
    recv: RecvStream,
    pending: Bytes,
    eof: bool,
    closed: bool,
}

impl H2Pipe {
    pub(crate) fn new(send: SendStream<Bytes>, recv: RecvStream) -> Self {
        Self { send, recv, pending: Bytes::new(), eof: false, closed: false }
    }
}

fn h2_io(e: h2::Error) -> io::Error {
    if e.is_io() {
        return e.into_io().unwrap_or_else(|| io::ErrorKind::Other.into());
    }
    let kind = if e.is_reset() || e.is_go_away() { io::ErrorKind::ConnectionReset } else { io::ErrorKind::Other };
    io::Error::new(kind, e)
}

impl AsyncRead for H2Pipe {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        while this.pending.is_empty() && !this.eof {
            match ready!(this.recv.poll_data(cx)) {
                Some(Ok(chunk)) => {
                    // Hand the bytes back to the window as soon as they are ours;
                    // the reader of this pipe (TLS) applies its own backpressure
                    // by not polling.
                    this.recv.flow_control().release_capacity(chunk.len()).map_err(h2_io)?;
                    this.pending = chunk;
                }
                Some(Err(e)) => return Poll::Ready(Err(h2_io(e))),
                None => this.eof = true,
            }
        }
        let n = this.pending.len().min(buf.remaining());
        buf.put_slice(&this.pending[..n]);
        this.pending.advance(n);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for H2Pipe {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        if this.closed {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let want = buf.len().min(MAX_WRITE);
        loop {
            let capacity = this.send.capacity();
            if capacity > 0 {
                let n = capacity.min(want);
                this.send.send_data(Bytes::copy_from_slice(&buf[..n]), false).map_err(h2_io)?;
                return Poll::Ready(Ok(n));
            }
            this.send.reserve_capacity(want);
            match ready!(this.send.poll_capacity(cx)) {
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Poll::Ready(Err(h2_io(e))),
                None => return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
            }
        }
    }

    // h2's connection task writes frames out; there is nothing to flush here.
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    // Half-close: END_STREAM on our side, reads stay open.
    fn poll_shutdown(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        if !self.closed {
            self.closed = true;
            self.send.send_data(Bytes::new(), true).map_err(h2_io)?;
        }
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// A reverse tunnel's two ends over one HTTP/2 stream, on a loopback
    /// connection: the device's (it POSTed) and the host's (it answered 200).
    /// The connection tasks are returned to be aborted, as a dropped link would be.
    async fn tunnel() -> (H2Pipe, H2Pipe, tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
        let addr = listener.local_addr().expect("bound");
        let host = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accepts");
            let mut conn = h2::server::handshake(socket).await.expect("h2");
            let (request, mut respond) = conn.accept().await.expect("a stream").expect("h2");
            let send = respond.send_response(http::Response::new(()), false).expect("200");
            let driver = tokio::spawn(async move { while conn.accept().await.is_some() {} });
            (H2Pipe::new(send, request.into_body()), driver)
        });
        let socket = tokio::net::TcpStream::connect(addr).await.expect("connects");
        let (mut client, conn) = h2::client::handshake(socket).await.expect("h2");
        let device_driver = tokio::spawn(async move {
            let _ = conn.await;
        });
        let request = http::Request::post("/peer/reverse").body(()).expect("a request");
        let (response, send) = client.send_request(request, false).expect("sent");
        let (host_pipe, host_driver) = host.await.expect("the host");
        let response = response.await.expect("the answer");
        (H2Pipe::new(send, response.into_body()), host_pipe, device_driver, host_driver)
    }

    async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), future).await.unwrap_or_else(|_| panic!("{what}: no end"))
    }

    #[tokio::test]
    async fn a_stream_reset_in_the_middle_of_a_body_is_an_error_never_an_end() {
        let (mut device, mut host, _d, _h) = tunnel().await;
        host.write_all(&[7u8; 50_000]).await.expect("half of what it meant to send");
        // The host goes away without closing its side: the stream is reset.
        drop(host);
        let mut got = Vec::new();
        let read = within("the read", device.read_to_end(&mut got)).await;
        let error = read.expect_err("a cut body must not read as a whole one");
        assert_eq!(error.kind(), io::ErrorKind::ConnectionReset, "{error}");
        assert!(got.len() <= 50_000 && got.iter().all(|b| *b == 7), "what came before the reset is intact");
        let write = within("the write", device.write_all(&[1u8; 300_000])).await;
        assert!(write.is_err(), "writing into a reset stream fails");
    }

    #[tokio::test]
    async fn a_link_that_drops_in_the_middle_of_a_body_is_an_error_never_an_end() {
        let (mut device, mut host, device_driver, host_driver) = tunnel().await;
        host.write_all(&[7u8; 50_000]).await.expect("written");
        // The whole connection goes: both of its tasks end, the socket closes.
        host_driver.abort();
        device_driver.abort();
        drop(host);
        let mut got = Vec::new();
        let read = within("the read", device.read_to_end(&mut got)).await;
        assert!(read.is_err(), "a cut body must not read as a whole one: {read:?}");
    }

    /// One end as TLS drives it: reading and writing at once. It writes
    /// `out`, closes its side as soon as that is sent, and reads to the end.
    async fn talk(pipe: H2Pipe, out: Vec<u8>) -> Vec<u8> {
        let (mut reader, mut writer) = tokio::io::split(pipe);
        let writing = tokio::spawn(async move {
            writer.write_all(&out).await.expect("writes");
            writer.shutdown().await.expect("closes its side");
            // Closed is closed: another write fails, another shutdown changes nothing.
            let again = writer.write(b"late").await.expect_err("written after the end");
            assert_eq!(again.kind(), io::ErrorKind::BrokenPipe);
            writer.shutdown().await.expect("a second shutdown is harmless");
        });
        let mut got = Vec::new();
        reader.read_to_end(&mut got).await.expect("reads to the end");
        writing.await.expect("the writer");
        got
    }

    #[tokio::test]
    async fn both_ends_closing_at_once_still_deliver_everything_then_the_end() {
        let to_host: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
        let to_device: Vec<u8> = (0..150_000u32).map(|n| (n % 241) as u8).collect();
        // Several rounds: the two half-closes land in a different order each time.
        for _ in 0..20 {
            let (device, host, _d, _h) = tunnel().await;
            let device_side = tokio::spawn(talk(device, to_host.clone()));
            let host_side = tokio::spawn(talk(host, to_device.clone()));
            let from_host = within("the device", device_side).await.expect("the device's task");
            let from_device = within("the host", host_side).await.expect("the host's task");
            assert!(from_host == to_device && from_device == to_host, "every byte, in order, both ways");
        }
    }

    #[tokio::test]
    async fn one_end_closed_still_hears_the_other() {
        let (mut device, mut host, _d, _h) = tunnel().await;
        device.write_all(b"request").await.expect("written");
        device.shutdown().await.expect("closed its side");
        let mut got = Vec::new();
        within("the host's read", host.read_to_end(&mut got)).await.expect("the end");
        assert_eq!(got, b"request");
        // The other way stays open after the device's half-close.
        host.write_all(b"answer").await.expect("the host still writes");
        host.shutdown().await.expect("closed");
        let mut answer = Vec::new();
        within("the device's read", device.read_to_end(&mut answer)).await.expect("the end");
        assert_eq!(answer, b"answer");
    }
}
