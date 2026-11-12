//! The transition: the Rust router answers the routes it declares, the isolated Node daemon
//! answers the rest. As routes land in Rust the daemon's share shrinks to nothing.
//!
//! Each request is logged at debug level under `eos::bridge` with the side that served it,
//! and the status counts both sides, so the Rust share can be watched growing.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::proxy::DevDaemon;
use crate::core::{Core, Plane};
use crate::router::RouterCore;
use crate::token::TOKEN_HEADER;
use crate::transport::{Req, Sink};

/// The event stream's routes. The Rust runtime declares them from its first day, but most
/// of the events the dashboard lives on (workers, agents) still come from the daemon: sent
/// to Rust, the dashboard would load and then never update. They stay with the daemon until
/// the features that produce those events are in Rust; meanwhile the Rust core's own events
/// are woven into the daemon's stream (`weave`).
pub const STREAM_ROUTES: [&str; 2] = ["/stream", "/stream/focus"];

pub struct Hybrid {
    rust: Arc<RouterCore>,
    daemon: Arc<DevDaemon>,
    rt: tokio::runtime::Handle,
    /// Route patterns the daemon keeps although Rust declares them.
    held_back: Vec<String>,
    /// The run was started with `EOS_DEV_ALLOW_AGENTS=1`: the Rust core may run agents.
    allow_agents: bool,
    /// The copied data folder: the only place the Files panel's writes may land.
    data_folder: Option<std::path::PathBuf>,
    by_rust: AtomicU64,
    by_daemon: AtomicU64,
    /// Requests the Rust core was not given because they could make an agent run.
    refused: AtomicU64,
    /// The patterns Rust has served: bounded by the number of routes it declares.
    rust_routes: Mutex<BTreeSet<String>>,
}

impl std::fmt::Debug for Hybrid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hybrid").field("held_back", &self.held_back).finish_non_exhaustive()
    }
}

fn path_of(target: &str) -> &str {
    target.split_once('?').map_or(target, |(path, _)| path)
}

impl Hybrid {
    /// Must be called inside the runtime the app's tasks run on.
    pub fn new(rust: Arc<RouterCore>, daemon: Arc<DevDaemon>) -> Self {
        Hybrid {
            rust,
            daemon,
            rt: tokio::runtime::Handle::current(),
            held_back: Vec::new(),
            allow_agents: false,
            data_folder: None,
            by_rust: AtomicU64::new(0),
            by_daemon: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            rust_routes: Mutex::default(),
        }
    }

    /// Keeps these route patterns with the daemon even when Rust declares them.
    #[must_use]
    pub fn hold_back<S: Into<String>>(mut self, patterns: impl IntoIterator<Item = S>) -> Self {
        self.held_back.extend(patterns.into_iter().map(Into::into));
        self
    }

    /// The data folder the Rust core runs on: a copy of real data. Writes of the Files
    /// panel are let through only inside it.
    #[must_use]
    pub fn data_folder(mut self, folder: impl Into<std::path::PathBuf>) -> Self {
        self.data_folder = Some(folder.into());
        self
    }

    /// Lets the Rust core answer everything: what starts an agent, a model call or a command,
    /// reaches another computer, or changes the user's own folders. Without it such requests
    /// are refused before its router sees them (`guard::allows_rust`).
    #[must_use]
    pub fn allow_agents(mut self, allow: bool) -> Self {
        self.allow_agents = allow;
        self
    }

    /// Whether this is the event stream the daemon keeps although Rust declares it.
    fn weaves(&self, req: &Req) -> bool {
        path_of(&req.url) == "/stream" && self.held_back.iter().any(|pattern| pattern == "/stream")
    }

    /// The pattern of the Rust route that answers this request, if Rust is to answer it.
    fn rust_route(&self, plane: Plane, req: &Req) -> Option<String> {
        // The raw-content origin has no routes in Rust yet.
        if plane != Plane::Api {
            return None;
        }
        let pattern = self.rust.pattern(&req.method, &req.url)?;
        (!self.held_back.contains(&pattern)).then_some(pattern)
    }
}

impl Core for Hybrid {
    fn ui_token(&self) -> String {
        self.rust.ui_token()
    }

    fn call(&self, plane: Plane, mut req: Req, sink: Sink) {
        match self.rust_route(plane, &req) {
            Some(pattern)
                if !self.allow_agents
                    && !super::guard::allows_rust(&req.method, &pattern, &req.body, self.data_folder.as_deref()) =>
            {
                self.refused.fetch_add(1, Ordering::Relaxed);
                tracing::debug!(target: "eos::bridge", side = "refused", method = %req.method, route = %pattern);
                sink.respond(
                    403,
                    vec![("content-type".into(), "application/json".into())],
                    super::guard::REFUSAL.as_bytes(),
                );
            }
            Some(pattern) => {
                self.by_rust.fetch_add(1, Ordering::Relaxed);
                tracing::debug!(target: "eos::bridge", side = "rust", method = %req.method, route = %pattern, path = %path_of(&req.url));
                if let Ok(mut routes) = self.rust_routes.lock() {
                    routes.insert(format!("{} {pattern}", req.method));
                }
                self.rust.call(plane, req, sink);
            }
            // The daemon keeps the event stream, and the Rust core's own events join it.
            None if plane == Plane::Api && req.method == "GET" && self.weaves(&req) => {
                self.by_daemon.fetch_add(1, Ordering::Relaxed);
                let (rust_sink, rust_body) = crate::transport::channel();
                let (daemon_sink, daemon_body) = crate::transport::channel();
                // Where the page left off is a place in the daemon's stream, not in Rust's.
                let mut fresh = req.clone();
                fresh.url = path_of(&req.url).to_owned();
                fresh.headers.retain(|(name, _)| !name.eq_ignore_ascii_case("last-event-id"));
                self.rust.call(plane, fresh, rust_sink);
                self.daemon.call(plane, req, daemon_sink);
                self.rt.spawn(super::weave::weave(daemon_body, rust_body, sink));
            }
            None => {
                self.by_daemon.fetch_add(1, Ordering::Relaxed);
                // The dashboard holds one token: Rust's. Should the daemon have another
                // (separate data folders), a request that proved itself gets the daemon's.
                let (ours, theirs) = (self.rust.ui_token(), self.daemon.ui_token());
                if ours != theirs && crate::token::authorized(&ours, &req) {
                    req.set_header(TOKEN_HEADER, &theirs);
                }
                self.daemon.call(plane, req, sink);
            }
        }
    }

    fn status(&self) -> Value {
        let (forwarded, refused) = self.daemon.counts();
        json!({
            "rust": self.by_rust.load(Ordering::Relaxed),
            "proxy": self.by_daemon.load(Ordering::Relaxed),
            "proxyForwarded": forwarded,
            "proxyRefusedWrites": refused,
            "rustRefused": self.refused.load(Ordering::Relaxed),
            "agentsAllowed": self.allow_agents,
            "rustRoutes": self.rust_routes.lock().map(|routes| routes.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "heldBack": self.held_back,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use eos_runtime::access::{Access, Caller};
    use eos_runtime::http::{ApiError, Request, Response};
    use eos_runtime::router::{RouteDef, Router};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::dev::DevDaemonConfig;
    use crate::router::Classify;
    use crate::transport::{Body, Head, Read, channel};

    const RUST_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DAEMON_TOKEN: &str = "dddddddddddddddddddddddddddddddd";

    async fn from_rust(req: Request) -> Result<Response, ApiError> {
        Ok(Response::json(200, &json!({ "side": "rust", "user": req.speaks_for_user() })))
    }

    /// A daemon that answers every request with the request line and token it saw.
    async fn daemon() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                    let line = head.lines().next().unwrap_or("").to_string();
                    let token =
                        head.lines().find_map(|l| l.strip_prefix("x-eos-ui-token: ")).unwrap_or("-").to_string();
                    let body = format!("daemon|{line}|{token}");
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        base
    }

    async fn hybrid(daemon_token: &str) -> Hybrid {
        let router = Router::builder()
            .route(RouteDef::get("/api/pages", from_rust).access(Access::open()))
            .route(RouteDef::put("/api/pages/{id}", from_rust).access(Access::ui_token()))
            .route(RouteDef::get("/stream", from_rust).access(Access::open()))
            .route(RouteDef::post("/workers/{id}/message", from_rust).access(Access::open()))
            .route(RouteDef::post("/workers/{id}/brand-new", from_rust).access(Access::open()))
            .build()
            .expect("valid routes");
        let rt = tokio::runtime::Handle::current();
        let classify: Classify =
            Arc::new(|given| if given == Some(RUST_TOKEN) { Caller::DASHBOARD } else { Caller::UNTRUSTED });
        let rust = Arc::new(RouterCore::new(Arc::new(router), RUST_TOKEN, classify, rt.clone()));
        let base = daemon().await;
        let config = DevDaemonConfig { api_base: base.clone(), raw_base: base, ui_token: daemon_token.to_string() };
        Hybrid::new(rust, Arc::new(DevDaemon::new(config, rt).unwrap())).hold_back(STREAM_ROUTES)
    }

    async fn ask(core: &Hybrid, plane: Plane, method: &str, target: &str, token: Option<&str>) -> (Head, String) {
        let (sink, body) = channel();
        let headers = token.map(|t| (TOKEN_HEADER.to_string(), t.to_string())).into_iter().collect();
        core.call(plane, Req { method: method.into(), url: target.into(), headers, ..Default::default() }, sink);
        let text = read_to_end(&body).await;
        (body.head().expect("head"), text)
    }

    async fn read_to_end(body: &Body) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        for _ in 0..600 {
            match body.read(&mut buf, || {}) {
                Read::Data(n) => out.extend_from_slice(&buf[..n]),
                Read::End => return String::from_utf8_lossy(&out).into_owned(),
                Read::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        panic!("the body never ended");
    }

    #[tokio::test]
    async fn rust_answers_what_it_declares_and_the_daemon_the_rest() {
        let core = hybrid(RUST_TOKEN).await;
        let (_, body) = ask(&core, Plane::Api, "GET", "/api/pages?project=x", None).await;
        assert_eq!(body, r#"{"side":"rust","user":false}"#);
        let (_, body) = ask(&core, Plane::Api, "PUT", "/api/pages/p1", Some(RUST_TOKEN)).await;
        assert_eq!(body, r#"{"side":"rust","user":true}"#);
        // Not declared in Rust: another path, another method of a declared path.
        let (_, body) = ask(&core, Plane::Api, "GET", "/workers?x=1", None).await;
        assert_eq!(body, "daemon|get /workers?x=1 http/1.1|-");
        let (_, body) = ask(&core, Plane::Api, "GET", "/api/pages/p1", None).await;
        assert!(body.starts_with("daemon|get /api/pages/p1 "), "{body}");
        // The raw origin stays with the daemon.
        let (_, body) = ask(&core, Plane::Raw, "GET", "/api/pages", None).await;
        assert!(body.starts_with("daemon|"), "{body}");
        let status = core.status();
        assert_eq!((status["rust"].as_u64(), status["proxy"].as_u64()), (Some(2), Some(3)));
        assert_eq!(status["rustRoutes"], json!(["GET /api/pages", "PUT /api/pages/{id}"]));
    }

    #[tokio::test]
    async fn the_rust_core_never_sees_a_request_that_could_make_an_agent_run() {
        let core = hybrid(RUST_TOKEN).await;
        for target in ["/workers/w1/message", "/workers/w1/brand-new"] {
            let (head, body) = ask(&core, Plane::Api, "POST", target, Some(RUST_TOKEN)).await;
            assert_eq!(head.status, 403, "{target}");
            assert!(body.contains("refused in a dev run"), "{body}");
        }
        let status = core.status();
        assert_eq!((status["rust"].as_u64(), status["rustRefused"].as_u64()), (Some(0), Some(2)));
        // A run started to try agents lets them through.
        let allowed = hybrid(RUST_TOKEN).await.allow_agents(true);
        let (head, body) = ask(&allowed, Plane::Api, "POST", "/workers/w1/message", Some(RUST_TOKEN)).await;
        assert_eq!((head.status, body.as_str()), (200, r#"{"side":"rust","user":true}"#));
    }

    #[tokio::test]
    async fn the_event_stream_stays_with_the_daemon_while_held_back() {
        let core = hybrid(RUST_TOKEN).await;
        let (_, body) = ask(&core, Plane::Api, "GET", "/stream?topics=x", None).await;
        assert!(body.starts_with("daemon|get /stream?topics=x "), "{body}");
        // Without the hold-back Rust serves it.
        let mut open = hybrid(RUST_TOKEN).await;
        open.held_back.clear();
        assert_eq!(ask(&open, Plane::Api, "GET", "/stream", None).await.1, r#"{"side":"rust","user":false}"#);
    }

    #[tokio::test]
    async fn a_write_to_an_agent_route_is_still_refused_on_the_way_to_the_daemon() {
        let core = hybrid(RUST_TOKEN).await;
        // A route the Rust core does not declare: the daemon's side refuses it.
        let (head, _) = ask(&core, Plane::Api, "POST", "/workers/w1/resume", Some(RUST_TOKEN)).await;
        assert_eq!(head.status, 403);
        assert_eq!(core.status()["proxyRefusedWrites"], 1);
    }

    #[tokio::test]
    async fn with_two_data_folders_a_proven_request_gets_the_daemons_token() {
        let core = hybrid(DAEMON_TOKEN).await;
        assert_eq!(core.ui_token(), RUST_TOKEN, "the dashboard holds Rust's token");
        let (_, body) = ask(&core, Plane::Api, "GET", "/api/settings", Some(RUST_TOKEN)).await;
        assert!(body.ends_with(&format!("|{DAEMON_TOKEN}")), "swapped for the daemon's");
        // A wrong token is passed on as it is: the daemon refuses it itself.
        let (_, body) = ask(&core, Plane::Api, "GET", "/api/settings", Some("wrong")).await;
        assert!(body.ends_with("|wrong"), "{body}");
        let (_, body) = ask(&core, Plane::Api, "GET", "/api/settings", None).await;
        assert!(body.ends_with("|-"), "{body}");
    }
}
