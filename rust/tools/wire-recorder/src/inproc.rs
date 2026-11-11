//! The Rust core as a target: the composed app's router, called in process.
//!
//! There is no listener: a request becomes a router call tagged with its
//! caller, as the shell's bridge will tag it. The ui-token header decides
//! between the dashboard and an untrusted page. Requests for the raw-content
//! origin go to its own router, where no caller is the dashboard.

use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Context;
use eos_app::{App, Options};
use eos_runtime::http::{Body, Method, Request as CoreRequest};

use crate::model::Via;
use crate::sse::SseParser;
use crate::target::{Request, Response, Stream, Target};

const TOKEN_HEADER: &str = "x-eos-ui-token";
/// The PDF viewer the daemon serves from the repository; the app gets its copy from the host.
const PDFJS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../manager/vendor/pdfjs");
/// How long a streamed answer to a plain request may stay silent before it is taken as complete.
const STREAM_QUIET: Duration = Duration::from_millis(300);

#[derive(Clone)]
pub struct RustTarget {
    app: Arc<App>,
    runtime: Arc<tokio::runtime::Runtime>,
}

impl std::fmt::Debug for RustTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RustTarget").field("app", &self.app).finish_non_exhaustive()
    }
}

impl RustTarget {
    /// Builds and starts the app on the data folder `home`.
    pub fn start(home: &Path) -> anyhow::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().context("the async runtime")?;
        let app = App::build(Options { pdfjs_root: Some(PDFJS.into()), ..Options::new(home) })
            .with_context(|| format!("building the app on {}", home.display()))?;
        runtime.block_on(app.start()).context("starting the app")?;
        Ok(Self { app: Arc::new(app), runtime: Arc::new(runtime) })
    }

    /// Stops the app and saves what it still has to write.
    pub fn stop(&self) {
        self.runtime.block_on(self.app.shutdown(Duration::from_secs(5)));
    }

    /// The request as the router takes it; `None` when no route can match
    /// (an unknown method).
    fn core_request(&self, request: &Request) -> Option<CoreRequest> {
        let method = Method::parse(&request.method)?;
        let token = request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case(TOKEN_HEADER));
        // Nothing on the raw-content origin is the dashboard, whatever it sends.
        let caller = match request.via {
            Via::Raw => eos_runtime::access::Caller::UNTRUSTED,
            _ => self.app.callers().classify(token.map(|(_, value)| value.as_str())),
        };
        let mut core = CoreRequest::new(method, &request.target, caller);
        for (name, value) in &request.headers {
            core = core.header(name, value);
        }
        Some(core.body(request.body.clone().unwrap_or_default()))
    }

    /// The API router, or the raw-content origin's own.
    fn router(&self, request: &Request) -> Arc<eos_runtime::router::Router> {
        match request.via {
            Via::Raw => self.app.raw_router(),
            _ => self.app.router(),
        }
    }

    fn headers(response: &eos_runtime::http::Response) -> Vec<(String, String)> {
        response.headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()
    }
}

/// What a request the router has no route for answers, as today's daemon words it.
fn not_found(target: &str) -> Response {
    let path = target.split('?').next().unwrap_or_default();
    let body = serde_json::json!({ "error": "not found", "path": path }).to_string().into_bytes();
    Response { status: 404, headers: vec![("content-type".into(), "application/json".into())], body }
}

impl Target for RustTarget {
    fn send(&mut self, request: &Request) -> anyhow::Result<Response> {
        let Some(core) = self.core_request(request) else { return Ok(not_found(&request.target)) };
        let router = self.router(request);
        self.runtime.block_on(async move {
            let response = router.handle(core).await;
            let (status, headers) = (response.status, Self::headers(&response));
            let body = match response.body {
                // A plain request that lands on a stream route (a scenario
                // probing its door) would never end: keep what arrives until
                // the stream falls quiet.
                Body::Stream(mut stream) => {
                    let mut body = Vec::new();
                    while let Ok(Some(Ok(chunk))) = tokio::time::timeout(STREAM_QUIET, stream.next()).await {
                        body.extend_from_slice(&chunk);
                    }
                    body
                }
                whole => whole.collect().await.map_err(|e| anyhow::anyhow!("{e}"))?.to_vec(),
            };
            Ok(Response { status, headers, body })
        })
    }

    fn open_stream(&mut self, request: &Request) -> anyhow::Result<Stream> {
        let core = self.core_request(request).context("a stream needs a method and an origin the core serves")?;
        let router = self.router(request);
        let response = self.runtime.block_on(router.handle(core));
        let (status, headers) = (response.status, Self::headers(&response));
        let (tx, rx) = mpsc::channel();
        let reader = self.runtime.spawn(async move {
            let Body::Stream(mut body) = response.body else { return };
            let mut parser = SseParser::default();
            let mut pending = String::new();
            while let Some(Ok(chunk)) = body.next().await {
                pending.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(end) = pending.find('\n') {
                    let line: String = pending.drain(..=end).collect();
                    if let Some(item) = parser.line(line.trim_end_matches(['\n', '\r']))
                        && tx.send(item).is_err()
                    {
                        return;
                    }
                }
            }
        });
        // Dropping the task drops the body: the core sees the client leave.
        Ok(Stream::new(status, headers, rx, move || reader.abort()))
    }

    fn fork(&self) -> Box<dyn Target + Send> {
        Box::new(self.clone())
    }

    fn serves(&self, request: &Request) -> bool {
        self.core_request(request).is_some_and(|core| self.router(request).find(core.method, &request.target).is_some())
    }
}
