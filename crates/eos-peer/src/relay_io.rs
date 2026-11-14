//! A relayed pipe as a byte stream. The relay side speaks in chunks (one relay
//! message each); TLS wants a stream. Two small pumps join them through a
//! bounded in-memory pipe, so a slow relay holds TLS back and a burst of TLS
//! records leaves as one message instead of one message per record.

use std::sync::Arc;

use bytes::Bytes;
use eos_core::net::relay::RelayPipe;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::channel::BoxIo;

/// One relay message carries at most this much of a write burst.
const BATCH_BYTES: usize = 256 * 1024;

pub(crate) fn relay_stream(pipe: Box<dyn RelayPipe>) -> BoxIo {
    let pipe: Arc<dyn RelayPipe> = Arc::from(pipe);
    let (ours, theirs) = tokio::io::duplex(BATCH_BYTES);
    let (mut from_tls, mut to_tls) = tokio::io::split(theirs);
    // Relay → TLS. Ends when the other end is gone or TLS stopped reading.
    let incoming = pipe.clone();
    tokio::spawn(async move {
        while let Some(chunk) = incoming.read().await {
            if to_tls.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = to_tls.shutdown().await;
    });
    // TLS → relay: whatever is waiting, up to one batch. When TLS is done
    // with the stream the pipe is left.
    tokio::spawn(async move {
        let mut buf = vec![0u8; BATCH_BYTES];
        loop {
            match from_tls.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if pipe.write(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break;
                    }
                }
            }
        }
        pipe.close();
    });
    Box::new(ours)
}
