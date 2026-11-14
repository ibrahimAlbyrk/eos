//! One request on a live session, and its answer as a stream.

use std::io::Write;

use bytes::Bytes;
use eos_core::BoxFuture;
use eos_core::net::peer::ByteStream;
use flate2::write::GzDecoder;
use h2::RecvStream;
use h2::client::SendRequest;
use http::{HeaderName, HeaderValue, Method, Request};

use crate::channel::h2util::{finish, next_chunk, send_all};

pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: RecvStream,
}

/// Sends a request and resolves when the answer's head arrives. A GET or
/// HEAD carries no body, as on today's facade.
pub(crate) async fn send(
    sender: SendRequest<Bytes>,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: Bytes,
) -> Result<Answer, String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let has_body = method != Method::GET && method != Method::HEAD;
    let mut request = Request::builder()
        .method(method)
        .uri(format!("https://eos-peer{target}"))
        .body(())
        .map_err(|e| e.to_string())?;
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
            request.headers_mut().append(name, value);
        }
    }
    let mut sender = sender.ready().await.map_err(|e| e.to_string())?;
    let (response, mut stream) = sender.send_request(request, !has_body).map_err(|e| e.to_string())?;
    if has_body {
        send_all(&mut stream, body).await.map_err(|e| e.to_string())?;
        finish(&mut stream).map_err(|e| e.to_string())?;
    }
    let response = response.await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned())))
        .collect();
    Ok(Answer { status, headers, body: response.into_body() })
}

/// A whole answer body, up to `limit` bytes.
pub(crate) async fn collect(mut body: RecvStream, limit: usize) -> Result<Bytes, String> {
    crate::channel::h2util::read_up_to(&mut body, limit)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "the answer is too large".to_owned())
}

/// An answer's body as it crosses to the caller here. Dropping it cancels
/// the stream on the host. A body the host gzipped is unpacked on the way.
pub(crate) struct LinkBody {
    recv: RecvStream,
    gunzip: Option<GzDecoder<Vec<u8>>>,
}

impl LinkBody {
    pub(crate) fn new(recv: RecvStream, gzipped: bool) -> Self {
        Self { recv, gunzip: gzipped.then(|| GzDecoder::new(Vec::new())) }
    }
}

impl ByteStream for LinkBody {
    fn next(&mut self) -> BoxFuture<'_, Option<Result<Bytes, String>>> {
        Box::pin(async move {
            loop {
                let chunk = match next_chunk(&mut self.recv).await? {
                    Ok(chunk) => chunk,
                    Err(e) => return Some(Err(e.to_string())),
                };
                let Some(gunzip) = &mut self.gunzip else { return Some(Ok(chunk)) };
                if let Err(e) = gunzip.write_all(&chunk).and_then(|()| gunzip.flush()) {
                    return Some(Err(e.to_string()));
                }
                let plain = std::mem::take(gunzip.get_mut());
                // A piece that held only gzip framing produces nothing yet.
                if !plain.is_empty() {
                    return Some(Ok(plain.into()));
                }
            }
        })
    }
}
