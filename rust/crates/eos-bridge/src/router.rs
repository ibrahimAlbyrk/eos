//! The core's router behind the bridge's [`Core`] trait: a page request becomes an
//! `eos_runtime` request tagged with its caller, and the response is pumped back as it
//! comes: whole bodies at once, streams chunk by chunk at the reader's pace.
//!
//! What stays intact across the mapping:
//! - **streams and Range**: a streamed body is forwarded chunk by chunk with back-pressure;
//!   a route that answers 206 does its own slicing, the bridge only carries the headers;
//! - **cancellation**: when the page drops the request, the handler's future (before the
//!   head) or the body's stream (after it) is dropped, which is how the runtime cancels;
//! - **the panic boundary**: the runtime turns a handler's panic into a 500; should the
//!   mapping task itself die, the request is still answered instead of left hanging.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use eos_runtime::access::Caller;
use eos_runtime::http::{Body, Method, Request, Response};
use eos_runtime::router::Router;

use crate::core::{Core, Plane};
use crate::token::TOKEN_HEADER;
use crate::transport::{Head, Req, Sink};

/// Who a local request comes from, told by the ui-token it carried (if any). `eos-app`'s
/// `Callers::classify`.
pub type Classify = Arc<dyn Fn(Option<&str>) -> Caller + Send + Sync>;

pub struct RouterCore {
    router: Arc<Router>,
    ui_token: String,
    classify: Classify,
    rt: tokio::runtime::Handle,
    served: AtomicU64,
}

impl std::fmt::Debug for RouterCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouterCore").field("router", &self.router).finish_non_exhaustive()
    }
}

fn json(status: u16, body: &'static [u8]) -> (u16, Vec<(String, String)>, &'static [u8]) {
    (status, vec![("content-type".into(), "application/json".into())], body)
}

/// Answers a request whose task ended without an answer, so the page never waits forever.
struct Unanswered {
    sink: Sink,
    armed: bool,
}

impl Drop for Unanswered {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if self.sink.has_head() {
            self.sink.end();
        } else {
            let (status, headers, body) = json(500, br#"{"error":"internal error"}"#);
            self.sink.respond(status, headers, body);
        }
    }
}

impl RouterCore {
    pub fn new(
        router: Arc<Router>,
        ui_token: impl Into<String>,
        classify: Classify,
        rt: tokio::runtime::Handle,
    ) -> Self {
        RouterCore { router, ui_token: ui_token.into(), classify, rt, served: AtomicU64::new(0) }
    }

    /// Whether the router has a route for this method and target (`/path?query`).
    pub fn declares(&self, method: &str, target: &str) -> bool {
        Method::parse(method).is_some_and(|method| self.router.find(method, target).is_some())
    }

    /// The pattern of the route a request resolves to (`/workers/{id}`), for logs.
    pub fn pattern(&self, method: &str, target: &str) -> Option<String> {
        Method::parse(method).and_then(|method| self.router.find(method, target)).map(|route| route.pattern.to_string())
    }

    /// Requests answered by the router so far.
    pub fn served(&self) -> u64 {
        self.served.load(Ordering::Relaxed)
    }
}

/// Sends the response to the page: its head, then its body as it comes.
async fn pump(response: Response, sink: &Sink) {
    let Response { status, headers, body, .. } = response;
    let headers: Vec<(String, String)> =
        headers.into_iter().map(|(name, value)| (name.into_owned(), value.into_owned())).collect();
    match body {
        Body::Empty => sink.respond(status, headers, b""),
        Body::Bytes(bytes) => sink.respond(status, headers, &bytes),
        Body::Stream(mut stream) => {
            sink.head(Head { status, headers });
            loop {
                tokio::select! {
                    next = stream.next() => match next {
                        Some(Ok(chunk)) => {
                            if !sink.chunk_async(&chunk).await {
                                break;
                            }
                        }
                        Some(Err(error)) => {
                            // The head is out: the body can only end short.
                            tracing::warn!(target: "eos::bridge", %error, "a response body failed midway");
                            break;
                        }
                        None => break,
                    },
                    // The page dropped the request: dropping the stream cancels its producer.
                    _ = sink.cancelled() => break,
                }
            }
            sink.end();
        }
    }
}

impl Core for RouterCore {
    fn ui_token(&self) -> String {
        self.ui_token.clone()
    }

    fn status(&self) -> serde_json::Value {
        serde_json::json!({ "rust": self.served() })
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        let Some(method) = Method::parse(&req.method) else {
            let (status, headers, body) = json(405, br#"{"error":"method not allowed"}"#);
            return sink.respond(status, headers, body);
        };
        self.served.fetch_add(1, Ordering::Relaxed);
        // The raw-content origin is another origin on purpose: nothing there is the dashboard,
        // whatever it sends.
        let caller = match plane {
            Plane::Api => (self.classify)(req.header(TOKEN_HEADER)),
            Plane::Raw => Caller::UNTRUSTED,
        };
        let mut request = Request::new(method, &req.url, caller);
        // The runtime keeps the headers routes read and drops the rest (the token included).
        for (name, value) in &req.headers {
            request.headers.insert(name, value);
        }
        let request = request.body(req.body);
        let router = self.router.clone();
        self.rt.spawn(async move {
            let mut unanswered = Unanswered { sink: sink.clone(), armed: true };
            tokio::select! {
                response = router.handle(request) => pump(response, &sink).await,
                // Dropping the handler's future is how the runtime cancels it.
                _ = sink.cancelled() => {}
            }
            unanswered.armed = false;
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    use eos_runtime::access::Access;
    use eos_runtime::http::{ApiError, file_response};
    use eos_runtime::router::RouteDef;
    use serde_json::{Value, json};

    use super::*;
    use crate::transport::{Body as PageBody, Read, channel};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    async fn who(req: Request) -> Result<Response, ApiError> {
        Ok(Response::json(
            200,
            &json!({ "user": req.speaks_for_user(), "id": req.param("id"), "q": req.query().get("q"), "body": req.body.len(), "type": req.headers.get("content-type"), "dest": req.headers.get("sec-fetch-dest") }),
        ))
    }

    async fn settings(_req: Request) -> Result<Response, ApiError> {
        Ok(Response::json(200, &json!({ "saved": true })))
    }

    async fn file(req: Request) -> Result<Response, ApiError> {
        let data: &'static [u8] = b"0123456789abcdefghij";
        Ok(file_response("application/octet-stream", data.len() as u64, req.headers.get("range"), |range| {
            let slice = range.map_or(data, |r| &data[r.start as usize..=r.end as usize]);
            Body::Bytes(bytes::Bytes::from_static(slice))
        }))
    }

    async fn boom(_req: Request) -> Result<Response, ApiError> {
        panic!("a handler lost its footing")
    }

    fn router(stream_dropped: Arc<AtomicBool>, handler_dropped: Arc<AtomicBool>) -> Arc<Router> {
        let ticks = move |_req: Request| {
            let dropped = stream_dropped.clone();
            async move {
                let (tx, body) = Body::channel(2);
                tokio::spawn(async move {
                    for i in 0u32.. {
                        if tx.send(format!("data: {i}\n\n")).await.is_err() {
                            dropped.store(true, Ordering::SeqCst);
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                });
                Ok(Response::new(200).header("content-type", "text/event-stream").body(body))
            }
        };
        let slow = move |_req: Request| {
            struct Flag(Arc<AtomicBool>);
            impl Drop for Flag {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
            let flag = Flag(handler_dropped.clone());
            async move {
                let _flag = flag;
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(Response::new(204))
            }
        };
        let router = Router::builder()
            .route(RouteDef::get("/workers/{id}", who).access(Access::open()))
            .route(RouteDef::post("/workers/{id}", who).access(Access::open()))
            .route(RouteDef::put("/api/settings", settings).access(Access::ui_token()))
            .route(RouteDef::get("/fs/raw/{*path}", file).access(Access::open()))
            .route(RouteDef::get("/ticks", ticks).access(Access::open()))
            .route(RouteDef::get("/slow", slow).access(Access::open()))
            .route(RouteDef::get("/boom", boom).access(Access::open()))
            .build()
            .expect("valid routes");
        Arc::new(router)
    }

    fn core() -> (RouterCore, Arc<AtomicBool>, Arc<AtomicBool>) {
        let (stream_dropped, handler_dropped) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        let classify: Classify =
            Arc::new(|given| if given == Some(TOKEN) { Caller::DASHBOARD } else { Caller::UNTRUSTED });
        let core = RouterCore::new(
            router(stream_dropped.clone(), handler_dropped.clone()),
            TOKEN,
            classify,
            tokio::runtime::Handle::current(),
        );
        (core, stream_dropped, handler_dropped)
    }

    fn req(method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Req {
        Req {
            method: method.into(),
            url: target.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: body.to_vec(),
            ..Default::default()
        }
    }

    async fn read_to_end(body: &PageBody) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        for _ in 0..400 {
            match body.read(&mut buf, || {}) {
                Read::Data(n) => out.extend_from_slice(&buf[..n]),
                Read::End => return out,
                Read::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        panic!("the body never ended");
    }

    async fn ask(core: &RouterCore, plane: Plane, request: Req) -> (Head, Vec<u8>) {
        let (sink, body) = channel();
        core.call(plane, request, sink);
        let bytes = read_to_end(&body).await;
        (body.head().expect("head"), bytes)
    }

    #[tokio::test]
    async fn a_request_reaches_its_route_with_params_query_body_and_read_headers() {
        let (core, ..) = core();
        let request = req(
            "POST",
            "/workers/w%201?q=a%20b",
            &[
                ("Content-Type", "application/json"),
                ("sec-fetch-dest", "empty"),
                ("cookie", "x=1"),
                ("x-eos-ui-token", TOKEN),
            ],
            b"{\"k\":1}",
        );
        let (head, body) = ask(&core, Plane::Api, request).await;
        assert_eq!(head.status, 200);
        assert_eq!(head.header("content-type"), Some("application/json"));
        assert_eq!(head.header("content-length"), Some(body.len().to_string().as_str()));
        assert!(head.header("x-request-id").is_some());
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value,
            json!({ "user": true, "id": "w%201", "q": "a b", "body": 7, "type": "application/json", "dest": "empty" })
        );
        assert_eq!(core.served(), 1);
    }

    #[tokio::test]
    async fn the_caller_is_the_dashboard_only_with_the_token_and_never_on_the_raw_origin() {
        let (core, ..) = core();
        let put = |headers: &'static [(&'static str, &'static str)]| req("PUT", "/api/settings", headers, b"{}");
        assert_eq!(ask(&core, Plane::Api, put(&[("x-eos-ui-token", TOKEN)])).await.0.status, 200);
        let (refused, body) = ask(&core, Plane::Api, put(&[])).await;
        assert_eq!(refused.status, 403, "{}", String::from_utf8_lossy(&body));
        assert_eq!(
            ask(&core, Plane::Api, put(&[("x-eos-ui-token", "0123456789abcdef0123456789abcdee")])).await.0.status,
            403
        );
        assert_eq!(
            ask(&core, Plane::Raw, put(&[("x-eos-ui-token", TOKEN)])).await.0.status,
            403,
            "the raw origin is never the dashboard"
        );
        let (head, body) = ask(&core, Plane::Api, req("GET", "/workers/w1", &[], b"")).await;
        assert_eq!(head.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["user"], false);
    }

    #[tokio::test]
    async fn an_undeclared_route_answers_as_the_router_answers_it() {
        let (core, ..) = core();
        assert!(core.declares("GET", "/workers/w1?x=1"));
        assert_eq!(core.pattern("GET", "/workers/w1?x=1").as_deref(), Some("/workers/{id}"));
        assert!(!core.declares("DELETE", "/workers/w1"));
        assert!(!core.declares("GET", "/nope"));
        assert!(!core.declares("BREW", "/workers/w1"));
        let (head, body) = ask(&core, Plane::Api, req("GET", "/nope/../nowhere", &[], b"")).await;
        assert_eq!(head.status, 404);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "error": "not found", "path": "/nowhere" })
        );
        assert_eq!(ask(&core, Plane::Api, req("BREW", "/workers/w1", &[], b"")).await.0.status, 405);
    }

    #[tokio::test]
    async fn range_is_the_routes_own_and_arrives_whole() {
        let (core, ..) = core();
        let (whole, body) = ask(&core, Plane::Raw, req("GET", "/fs/raw/a.bin", &[], b"")).await;
        assert_eq!((whole.status, body.as_slice()), (200, b"0123456789abcdefghij".as_slice()));
        assert_eq!(whole.header("accept-ranges"), Some("bytes"));
        let (part, body) = ask(&core, Plane::Raw, req("GET", "/fs/raw/a.bin", &[("Range", "bytes=10-14")], b"")).await;
        assert_eq!((part.status, body.as_slice()), (206, b"abcde".as_slice()));
        assert_eq!(part.header("content-range"), Some("bytes 10-14/20"));
        assert_eq!(part.header("content-length"), Some("5"));
        assert_eq!(part.headers.iter().filter(|(k, _)| k == "content-length").count(), 1);
    }

    #[tokio::test]
    async fn a_stream_arrives_chunk_by_chunk_and_stops_when_the_page_closes_it() {
        let (core, stream_dropped, _) = core();
        let (sink, body) = channel();
        core.call(Plane::Api, req("GET", "/ticks", &[], b""), sink);
        let mut seen = String::new();
        let mut buf = [0u8; 256];
        for _ in 0..400 {
            if seen.contains("data: 2\n\n") {
                break;
            }
            match body.read(&mut buf, || {}) {
                Read::Data(n) => seen.push_str(&String::from_utf8_lossy(&buf[..n])),
                Read::End => panic!("the stream ended by itself"),
                Read::Pending => tokio::time::sleep(Duration::from_millis(2)).await,
            }
        }
        assert!(seen.starts_with("data: 0\n\ndata: 1\n\n"), "{seen:?}");
        assert_eq!(body.head().unwrap().header("content-type"), Some("text/event-stream"));
        assert_eq!(body.head().unwrap().header("content-length"), None, "a stream has no length");
        assert!(!stream_dropped.load(Ordering::SeqCst));
        body.cancel();
        for _ in 0..400 {
            if stream_dropped.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the producer kept running after the page closed the stream");
    }

    #[tokio::test]
    async fn closing_before_the_head_cancels_the_handler() {
        let (core, _, handler_dropped) = core();
        let (sink, body) = channel();
        core.call(Plane::Api, req("GET", "/slow", &[], b""), sink);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(body.head().is_none());
        assert!(!handler_dropped.load(Ordering::SeqCst));
        body.cancel();
        for _ in 0..400 {
            if handler_dropped.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the handler kept running after the page dropped the request");
    }

    #[tokio::test]
    async fn a_panicking_handler_is_a_500_and_the_next_request_is_served() {
        let (core, ..) = core();
        let (head, body) = ask(&core, Plane::Api, req("GET", "/boom", &[], b"")).await;
        assert_eq!(head.status, 500);
        assert!(String::from_utf8_lossy(&body).contains("a handler lost its footing"));
        assert_eq!(ask(&core, Plane::Api, req("GET", "/workers/w1", &[], b"")).await.0.status, 200);
    }

    #[tokio::test]
    async fn a_task_that_dies_still_answers() {
        let (sink, body) = channel();
        drop(Unanswered { sink: sink.clone(), armed: true });
        assert_eq!(body.head().unwrap().status, 500);
        assert_eq!(read_to_end(&body).await, br#"{"error":"internal error"}"#);
        // With the head already out the body just ends.
        let (sink, body) = channel();
        sink.head(Head { status: 200, headers: vec![] });
        sink.chunk(b"part");
        drop(Unanswered { sink: sink.clone(), armed: true });
        assert_eq!(read_to_end(&body).await, b"part");
        // Disarmed: nothing happens.
        let (sink, body) = channel();
        drop(Unanswered { sink, armed: false });
        assert!(body.head().is_none());
    }
}
