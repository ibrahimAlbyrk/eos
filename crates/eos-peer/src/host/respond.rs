//! Answering a peer's stream.

use bytes::Bytes;
use h2::SendStream;
use h2::server::SendResponse;
use http::{HeaderName, HeaderValue, Response, StatusCode};
use serde::Serialize;

use crate::channel::h2util::{finish, send_all};

/// Sends the response head. `end` closes the stream with it.
pub(crate) fn send_head(
    respond: &mut SendResponse<Bytes>,
    status: u16,
    headers: &[(String, String)],
    end: bool,
) -> Option<SendStream<Bytes>> {
    let mut response = Response::new(());
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    for (name, value) in headers {
        // A header HTTP/2 cannot carry is left out rather than failing the answer.
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
            response.headers_mut().append(name, value);
        }
    }
    respond.send_response(response, end).ok()
}

/// `{ … }` with `content-type: application/json`, then the end of the stream.
pub(crate) async fn respond_json<T: Serialize>(mut respond: SendResponse<Bytes>, status: u16, body: &T) {
    let json = serde_json::to_vec(body).unwrap_or_default();
    let headers = [("content-type".to_owned(), "application/json".to_owned())];
    let Some(mut stream) = send_head(&mut respond, status, &headers, false) else { return };
    if send_all(&mut stream, Bytes::from(json)).await.is_ok() {
        let _ = finish(&mut stream);
    }
}

#[derive(Serialize)]
pub(crate) struct ErrorBody<'a> {
    pub(crate) error: &'a str,
}
