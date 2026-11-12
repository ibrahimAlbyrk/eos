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
