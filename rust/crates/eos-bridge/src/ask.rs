//! The shell's own calls on the core: a request as the user's dashboard (or as a host's
//! view) makes it, answered in process and read whole.

use serde_json::Value;
use tokio::sync::oneshot;

use crate::core::{Core, Plane};
use crate::token::TOKEN_HEADER;
use crate::transport::{Body, Head, Initiator, Read, Req, channel};

/// The largest answer read whole: the host list, a transfer list, a host's entry document.
pub const MAX_ANSWER: usize = 8 * 1024 * 1024;

/// The whole body once it ended; `None` when it is larger than `limit` or never had a head.
pub async fn collect(body: &Body, limit: usize) -> Option<(Head, Vec<u8>)> {
    let (tx, rx) = oneshot::channel();
    body.on_head(move || {
        let _ = tx.send(());
    });
    rx.await.ok()?;
    let head = body.head()?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let (tx, rx) = oneshot::channel();
        match body.read(&mut buf, move || {
            let _ = tx.send(());
        }) {
            Read::Data(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > limit {
                    return None;
                }
            }
            Read::End => return Some((head, out)),
            Read::Pending => {
                let _ = rx.await;
            }
        }
    }
}

/// One request with `token` as `x-eos-ui-token`; the answer's status and JSON body (`null`
/// when it has none).
pub async fn ask(
    core: &dyn Core,
    plane: Plane,
    method: &str,
    target: &str,
    token: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let (sink, reader) = channel();
    let mut headers = vec![(TOKEN_HEADER.to_owned(), token.to_owned())];
    if body.is_some() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let req = Req {
        initiator: Initiator::Document,
        method: method.to_owned(),
        url: target.to_owned(),
        headers,
        body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
    };
    core.call(plane, req, sink);
    let (head, bytes) = collect(&reader, MAX_ANSWER).await.ok_or_else(|| format!("{method} {target}: no answer"))?;
    Ok((head.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null)))
}
