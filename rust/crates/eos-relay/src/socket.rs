//! One WebSocket to the relay: dialling it, and the bounded queue its writer
//! drains.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use eos_core::net::relay::RelayError;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::envelope::{MAX_ENVELOPE_BYTES, MAX_MESSAGE_BYTES};

pub(crate) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub(crate) type Sink = SplitSink<Socket, Message>;
pub(crate) type Stream = SplitStream<Socket>;

/// Dials `url`. A relay that does not answer inside `timeout` counts as down.
pub(crate) async fn connect(url: &str, timeout: Duration) -> Result<(Sink, Stream), String> {
    let config =
        WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
    let dial = tokio_tungstenite::connect_async_with_config(url, Some(config), true);
    match tokio::time::timeout(timeout, dial).await {
        Ok(Ok((socket, _))) => Ok(socket.split()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("no answer in {} s", timeout.as_secs())),
    }
}

/// The budget is counted in KiB: a message costs its size rounded up, so
/// even empty ones are bounded in number.
fn cost(bytes: usize) -> u32 {
    u32::try_from(bytes / 1024 + 1).unwrap_or(u32::MAX)
}

struct Queued {
    frame: Bytes,
    /// Returned to the budget once the frame is written to the socket.
    _room: OwnedSemaphorePermit,
}

/// The queue towards one live socket. Bounded by a byte budget: a sender
/// waits for room in arrival order, and one that cannot wait is told the
/// queue is behind. When the socket dies the queue dies with it — what it
/// held was addressed to that connection's devices.
#[derive(Clone)]
pub(crate) struct Outbound {
    budget: Arc<Semaphore>,
    tx: mpsc::UnboundedSender<Queued>,
}

pub(crate) struct OutboundReader {
    rx: mpsc::UnboundedReceiver<Queued>,
}

impl Outbound {
    /// A queue that holds at most `bytes` (never less than one full message).
    pub(crate) fn new(bytes: usize) -> (Self, OutboundReader) {
        let budget = cost(bytes.max(MAX_ENVELOPE_BYTES)) as usize;
        // Unbounded in type only: every message in it holds part of the budget.
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { budget: Arc::new(Semaphore::new(budget)), tx }, OutboundReader { rx })
    }

    fn check(frame: &Bytes) -> Result<u32, RelayError> {
        if frame.len() > MAX_ENVELOPE_BYTES {
            return Err(RelayError::TooLarge { size: frame.len(), limit: MAX_ENVELOPE_BYTES });
        }
        Ok(cost(frame.len()))
    }

    pub(crate) async fn send(&self, frame: Bytes) -> Result<(), RelayError> {
        let cost = Self::check(&frame)?;
        let room = self.budget.clone().acquire_many_owned(cost).await.map_err(|_| RelayError::Offline)?;
        self.tx.send(Queued { frame, _room: room }).map_err(|_| RelayError::Offline)
    }

    /// Fails instead of waiting, also while others wait: the semaphore hands
    /// freed room to its waiters first, so this never overtakes one.
    pub(crate) fn try_send(&self, frame: Bytes) -> Result<(), RelayError> {
        let cost = Self::check(&frame)?;
        let room = self.budget.clone().try_acquire_many_owned(cost).map_err(|e| match e {
            TryAcquireError::NoPermits => RelayError::Behind,
            TryAcquireError::Closed => RelayError::Offline,
        })?;
        self.tx.send(Queued { frame, _room: room }).map_err(|_| RelayError::Offline)
    }

    /// Fails every sender still waiting for room.
    pub(crate) fn close(&self) {
        self.budget.close();
    }
}

/// Writes to the socket until it fails or both queues end. `urgent` (pings,
/// a registration) goes ahead of queued data, so a long queue on a slow link
/// does not delay the liveness check behind it.
pub(crate) async fn write_loop(mut sink: Sink, mut data: OutboundReader, mut urgent: mpsc::Receiver<Message>) {
    loop {
        let message = tokio::select! {
            biased;
            Some(message) = urgent.recv() => message,
            Some(queued) = data.rx.recv() => {
                // `send` returns once the frame is in the socket: only then is its room freed.
                if sink.send(Message::Binary(queued.frame.clone())).await.is_err() {
                    return;
                }
                continue;
            }
            else => break,
        };
        if sink.send(message).await.is_err() {
            return;
        }
    }
    let _ = sink.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_full_queue_makes_senders_wait_and_refuses_those_that_cannot() {
        let (out, mut reader) = Outbound::new(0);
        let big = Bytes::from(vec![0u8; MAX_ENVELOPE_BYTES]);
        out.send(big.clone()).await.expect("fits the budget");
        assert_eq!(out.try_send(Bytes::from_static(b"x")), Err(RelayError::Behind));

        let waiting = tokio::spawn({
            let out = out.clone();
            async move { out.send(Bytes::from_static(b"second")).await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "waits for room");

        // The writer takes the first message and finishes writing it.
        drop(reader.rx.recv().await.expect("queued"));
        waiting.await.expect("joins").expect("sent once there was room");
        assert_eq!(reader.rx.recv().await.expect("queued").frame, Bytes::from_static(b"second"));
    }

    #[tokio::test]
    async fn refuses_a_message_over_the_relays_limit_and_fails_waiters_when_the_socket_dies() {
        let (out, _reader) = Outbound::new(0);
        let over = Bytes::from(vec![0u8; MAX_ENVELOPE_BYTES + 1]);
        assert!(matches!(out.send(over).await, Err(RelayError::TooLarge { .. })));

        out.send(Bytes::from(vec![0u8; MAX_ENVELOPE_BYTES])).await.expect("fills the budget");
        let waiting = tokio::spawn({
            let out = out.clone();
            async move { out.send(Bytes::from_static(b"late")).await }
        });
        tokio::task::yield_now().await;
        out.close();
        assert_eq!(waiting.await.expect("joins"), Err(RelayError::Offline));
        assert_eq!(out.try_send(Bytes::from_static(b"x")), Err(RelayError::Offline));
    }
}
