//! Host side of a peer link (`manager/peer/gateway.ts`): a paired computer's
//! request, handed to this app's own router in process.
//!
//! The router is the boundary. The request arrives tagged with who sent it —
//! the device's certificate fingerprint and whether its dashboard vouched —
//! and each route's access rule decides: the local plane never crosses, and
//! everything but the public face needs the device's dashboard. Both are
//! judged on the resolved path, so `/ui/../policy/decide` does not pass as
//! `/ui/…`.

use std::sync::Arc;

use bytes::Bytes;
use eos_core::BoxFuture;
use eos_core::net::peer::{ByteStream, LocalApi, PeerAnswer, PeerCall};
use eos_runtime::access::Caller;
use eos_runtime::http::{Body, BodyStream, Method, Request, normalize_path, split_target};
use eos_runtime::router::Router;

/// The app's two routers as a paired computer reaches them: the API, and the
/// raw-content origin for a file viewer's content.
pub struct RouterApi {
    api: Arc<Router>,
    raw: Arc<Router>,
}

impl std::fmt::Debug for RouterApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RouterApi")
    }
}

impl RouterApi {
    pub fn new(api: Arc<Router>, raw: Arc<Router>) -> Self {
        Self { api, raw }
    }

    /// Raw content (`/fs/raw/…`, the PDF viewer) lives on its own router.
    fn router_for(&self, target: &str) -> &Router {
        let path = normalize_path(split_target(target).0);
        if path.starts_with("/fs/raw/") || path == "/pdfjs" || path.starts_with("/pdfjs/") {
            &self.raw
        } else {
            &self.api
        }
    }
}

enum AnswerBody {
    Whole(Option<Bytes>),
    Stream(BodyStream),
}

impl ByteStream for AnswerBody {
    fn next(&mut self) -> BoxFuture<'_, Option<Result<Bytes, String>>> {
        Box::pin(async move {
            match self {
                AnswerBody::Whole(bytes) => bytes.take().map(Ok),
                AnswerBody::Stream(stream) => stream.next().await.map(|chunk| chunk.map_err(|e| e.to_string())),
            }
        })
    }
}

fn error(status: u16, message: &str) -> PeerAnswer {
    let body = serde_json::json!({ "error": message }).to_string();
    PeerAnswer {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: Box::new(AnswerBody::Whole(Some(body.into()))),
    }
}

impl LocalApi for RouterApi {
    fn body_limit(&self, method: &str, target: &str) -> usize {
        Method::parse(method).map_or(0, |method| self.router_for(target).body_limit(method, target))
    }

    fn call(&self, call: PeerCall) -> BoxFuture<'_, PeerAnswer> {
        Box::pin(async move {
            let Some(method) = Method::parse(&call.method) else {
                return error(405, "method not allowed");
            };
            let caller = Caller::Peer { device: call.device.as_str().into(), human: call.human };
            let mut request = Request::new(method, &call.target, caller).body(call.body);
            for (name, value) in &call.headers {
                request = request.header(name, value);
            }
            let response = self.router_for(&call.target).handle(request).await;
            let body = match response.body {
                Body::Empty => AnswerBody::Whole(None),
                Body::Bytes(bytes) => AnswerBody::Whole(Some(bytes)),
                Body::Stream(stream) => AnswerBody::Stream(stream),
            };
            PeerAnswer {
                status: response.status,
                headers: response.headers.into_iter().map(|(n, v)| (n.into_owned(), v.into_owned())).collect(),
                body: Box::new(body),
            }
        })
    }
}
