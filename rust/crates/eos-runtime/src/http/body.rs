//! Response bodies: nothing, bytes in hand, or a stream of chunks.

use std::fmt;
use std::future::poll_fn;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_core::Stream;
use tokio::sync::mpsc;

/// A stream body failed part-way: the caller sees a cut-off response.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("response body failed: {0}")]
pub struct BodyError(pub String);

pub enum Body {
    Empty,
    Bytes(Bytes),
    Stream(BodyStream),
}

impl Body {
    /// A body fed through a bounded channel of `capacity` chunks. `send` waits
    /// while the caller is slow (back-pressure); dropping the body — the caller
    /// went away — makes `send` fail and `closed` resolve.
    pub fn channel(capacity: usize) -> (BodySender, Body) {
        let (tx, rx) = mpsc::channel(capacity.max(1));
        (BodySender { tx }, Body::Stream(BodyStream::new(Channel { rx })))
    }

    /// The whole body in memory. For tests and for gateways that frame one
    /// reply; a stream that never ends never returns.
    pub async fn collect(self) -> Result<Bytes, BodyError> {
        match self {
            Body::Empty => Ok(Bytes::new()),
            Body::Bytes(b) => Ok(b),
            Body::Stream(mut s) => {
                let mut out = Vec::new();
                while let Some(chunk) = s.next().await {
                    out.extend_from_slice(&chunk?);
                }
                Ok(out.into())
            }
        }
    }

    pub fn len_hint(&self) -> Option<usize> {
        match self {
            Body::Empty => Some(0),
            Body::Bytes(b) => Some(b.len()),
            Body::Stream(_) => None,
        }
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Empty => f.write_str("Body::Empty"),
            Body::Bytes(b) => write!(f, "Body::Bytes({} bytes)", b.len()),
            Body::Stream(_) => f.write_str("Body::Stream"),
        }
    }
}

impl From<Bytes> for Body {
    fn from(b: Bytes) -> Self {
        if b.is_empty() { Body::Empty } else { Body::Bytes(b) }
    }
}

/// Chunks pulled by whoever writes the response out. Pulling is the
/// back-pressure; dropping the stream is the cancellation.
pub struct BodyStream {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, BodyError>> + Send>>,
}

impl BodyStream {
    pub fn new(stream: impl Stream<Item = Result<Bytes, BodyError>> + Send + 'static) -> Self {
        Self { inner: Box::pin(stream) }
    }

    pub async fn next(&mut self) -> Option<Result<Bytes, BodyError>> {
        poll_fn(|cx| self.inner.as_mut().poll_next(cx)).await
    }
}

impl Stream for BodyStream {
    type Item = Result<Bytes, BodyError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

impl fmt::Debug for BodyStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BodyStream")
    }
}

struct Channel {
    rx: mpsc::Receiver<Result<Bytes, BodyError>>,
}

impl Stream for Channel {
    type Item = Result<Bytes, BodyError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

/// The caller dropped the response: stop producing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the caller went away")]
pub struct CallerGone;

/// The producing end of [`Body::channel`]. Dropping it ends the body.
#[derive(Debug, Clone)]
pub struct BodySender {
    tx: mpsc::Sender<Result<Bytes, BodyError>>,
}

impl BodySender {
    pub async fn send(&self, chunk: impl Into<Bytes>) -> Result<(), CallerGone> {
        self.tx.send(Ok(chunk.into())).await.map_err(|_| CallerGone)
    }

    /// Ends the body with an error instead of a clean end.
    pub async fn fail(self, message: impl Into<String>) {
        let _ = self.tx.send(Err(BodyError(message.into()))).await;
    }

    /// Resolves when the caller went away.
    pub async fn closed(&self) {
        self.tx.closed().await;
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_channel_body_applies_back_pressure_and_ends_when_the_sender_drops() {
        let (tx, body) = Body::channel(1);
        let producer = tokio::spawn(async move {
            for i in 0..5u8 {
                tx.send(vec![i]).await.expect("reader is there");
            }
        });
        assert_eq!(body.collect().await.expect("clean end").as_ref(), [0, 1, 2, 3, 4]);
        producer.await.expect("producer finished");
    }

    #[tokio::test]
    async fn a_full_channel_makes_the_sender_wait() {
        let (tx, body) = Body::channel(1);
        tx.send("a").await.expect("room for one");
        let blocked = tokio::time::timeout(Duration::from_millis(20), tx.send("b")).await;
        assert!(blocked.is_err(), "the second chunk waits for the reader");
        drop(body);
    }

    #[tokio::test]
    async fn dropping_the_body_cancels_the_producer() {
        let (tx, body) = Body::channel(1);
        assert!(!tx.is_closed());
        drop(body);
        tx.closed().await;
        assert_eq!(tx.send("late").await, Err(CallerGone));
    }

    #[tokio::test]
    async fn a_failed_body_surfaces_its_error() {
        let (tx, body) = Body::channel(2);
        tx.send("part").await.expect("room");
        tx.fail("disk went away").await;
        assert_eq!(body.collect().await, Err(BodyError("disk went away".into())));
    }
}
