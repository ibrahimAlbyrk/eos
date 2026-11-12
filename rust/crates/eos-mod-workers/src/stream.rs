//! Large answers leave in slices. The rows are read from a reader connection
//! a slice at a time while the client takes the body (`Body::Stream` waits for
//! it), so no answer is ever held whole; the bytes are those of the whole list
//! serialized at once.

use std::sync::Arc;

use eos_core::store::Store;
use eos_domain::EventRecord;
use eos_runtime::http::{Body, BodySender, Response};

/// A list of more rows than this is sent in slices.
pub(crate) const STREAM_ROWS: usize = 1_000;
/// Rows read at a time.
const SLICE: usize = 100;
/// About what one chunk of the body holds.
const CHUNK: usize = 64 * 1024;
/// Chunks written ahead of the client.
const AHEAD: usize = 4;

/// A JSON array written as it is read: `[`, the items with `,` between them, `]`.
pub(crate) struct ArrayWriter {
    tx: BodySender,
    buf: Vec<u8>,
    first: bool,
}

impl ArrayWriter {
    /// The writer and the response whose body it writes.
    pub(crate) fn json() -> (Self, Response) {
        let (tx, body) = Body::channel(AHEAD);
        let response = Response::new(200).header("content-type", "application/json").body(body);
        (Self::over(tx, b"["), response)
    }

    /// A writer that starts after `prefix` on `tx`.
    pub(crate) fn over(tx: BodySender, prefix: &[u8]) -> Self {
        let mut buf = Vec::with_capacity(CHUNK + CHUNK / 4);
        buf.extend_from_slice(prefix);
        Self { tx, buf, first: true }
    }

    /// Appends one item. `Err` when the client went away (stop reading).
    pub(crate) async fn item(&mut self, write: impl FnOnce(&mut Vec<u8>)) -> Result<(), ()> {
        if !self.first {
            self.buf.push(b',');
        }
        self.first = false;
        write(&mut self.buf);
        if self.buf.len() >= CHUNK {
            let full = std::mem::replace(&mut self.buf, Vec::with_capacity(CHUNK + CHUNK / 4));
            self.tx.send(full).await.map_err(drop)?;
        }
        Ok(())
    }

    /// Closes the array with `suffix` and ends the body.
    pub(crate) async fn finish(mut self, suffix: &[u8]) {
        self.buf.extend_from_slice(suffix);
        let _ = self.tx.send(std::mem::take(&mut self.buf)).await;
    }

    pub(crate) async fn fail(self, message: String) {
        self.tx.fail(message).await;
    }
}

/// The rows `ids` names (one worker's, in that order) as a JSON array of what
/// `encode` writes for each, read and sent a slice at a time.
pub(crate) fn rows(
    store: Arc<dyn Store>,
    worker_id: String,
    ids: Vec<i64>,
    encode: impl Fn(EventRecord, &mut Vec<u8>) + Send + Sync + 'static,
) -> Response {
    let (mut out, response) = ArrayWriter::json();
    tokio::spawn(async move {
        for slice in ids.chunks(SLICE) {
            let (worker, slice) = (worker_id.clone(), slice.to_vec());
            let rows = match store.read(move |tx| tx.events().find_many(&worker, &slice)).await {
                Ok(rows) => rows,
                Err(e) => return out.fail(e.to_string()).await,
            };
            for row in rows {
                if out.item(|buf| encode(row, buf)).await.is_err() {
                    return;
                }
            }
        }
        out.finish(b"]").await;
    });
    response
}
