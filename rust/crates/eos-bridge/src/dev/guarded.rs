//! The core of a dev run: the Rust router behind the guard.
//!
//! Each request is logged at debug level under `eos::bridge` with what became of it, and
//! the status counts what was served and what was refused, and which routes were served.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use super::guard;
use crate::core::{Core, Plane};
use crate::router::RouterCore;
use crate::transport::{Req, Sink};

pub struct Guarded {
    rust: Arc<RouterCore>,
    /// The run was started with `EOS_DEV_ALLOW_AGENTS=1`: the core may run agents.
    allow_agents: bool,
    /// The copied data folder: the only place the Files panel's writes may land.
    data_folder: Option<PathBuf>,
    refused: AtomicU64,
    /// The patterns served so far: bounded by the number of routes the router declares.
    served_routes: Mutex<BTreeSet<String>>,
}

impl std::fmt::Debug for Guarded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Guarded").field("allow_agents", &self.allow_agents).finish_non_exhaustive()
    }
}

fn path_of(target: &str) -> &str {
    target.split_once('?').map_or(target, |(path, _)| path)
}

impl Guarded {
    pub fn new(rust: Arc<RouterCore>) -> Self {
        Guarded {
            rust,
            allow_agents: false,
            data_folder: None,
            refused: AtomicU64::new(0),
            served_routes: Mutex::default(),
        }
    }

    /// The data folder the core runs on: a copy of real data. Writes of the Files panel are
    /// let through only inside it.
    #[must_use]
    pub fn data_folder(mut self, folder: impl Into<PathBuf>) -> Self {
        self.data_folder = Some(folder.into());
        self
    }

    /// Lets the core answer everything: what starts an agent, a model call or a command,
    /// reaches another computer, or changes the user's own folders. Without it such requests
    /// are refused before the router sees them (`guard::allows`).
    #[must_use]
    pub fn allow_agents(mut self, allow: bool) -> Self {
        self.allow_agents = allow;
        self
    }
}

impl Core for Guarded {
    fn ui_token(&self) -> String {
        self.rust.ui_token()
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        // How long the core took to the head: the page reads it from its resource timing
        // (`tests/responsiveness.py`).
        sink.time_head("rust");
        // The raw-content origin serves files as they are and the PDF viewer: reads only.
        let route = if plane == Plane::Api { self.rust.pattern(&req.method, &req.url) } else { None };
        if let Some(pattern) = &route {
            if !self.allow_agents && !guard::allows(&req.method, pattern, &req.body, self.data_folder.as_deref()) {
                self.refused.fetch_add(1, Ordering::Relaxed);
                tracing::debug!(target: "eos::bridge", side = "refused", method = %req.method, route = %pattern);
                return sink.respond(
                    403,
                    vec![("content-type".into(), "application/json".into())],
                    guard::REFUSAL.as_bytes(),
                );
            }
            if let Ok(mut routes) = self.served_routes.lock() {
                routes.insert(format!("{} {pattern}", req.method));
            }
        }
        tracing::debug!(target: "eos::bridge", side = "rust", method = %req.method, route = ?route, path = %path_of(&req.url));
        self.rust.call(plane, req, sink);
    }

    fn status(&self) -> Value {
        json!({
            "rust": self.rust.served(),
            "refused": self.refused.load(Ordering::Relaxed),
            "agentsAllowed": self.allow_agents,
            "routes": self.served_routes.lock().map(|routes| routes.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use eos_runtime::access::{Access, Caller};
    use eos_runtime::http::{ApiError, Request, Response};
    use eos_runtime::router::{RouteDef, Router};

    use super::*;
    use crate::router::Classify;
    use crate::token::TOKEN_HEADER;
    use crate::transport::{Body, Head, Read, channel};

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    async fn answer(req: Request) -> Result<Response, ApiError> {
        Ok(Response::json(200, &json!({ "user": req.speaks_for_user() })))
    }

    fn rust() -> Arc<RouterCore> {
        let router = Router::builder()
            .route(RouteDef::get("/api/pages", answer).access(Access::open()))
            .route(RouteDef::put("/api/pages/{id}", answer).access(Access::ui_token()))
            .route(RouteDef::post("/fs/write", answer).access(Access::ui_token()))
            .route(RouteDef::post("/workers/{id}/message", answer).access(Access::open()))
            .route(RouteDef::post("/workers/{id}/brand-new", answer).access(Access::open()))
            .build()
            .expect("valid routes");
        let classify: Classify =
            Arc::new(|given, _| if given == Some(TOKEN) { Caller::DASHBOARD } else { Caller::UNTRUSTED });
        Arc::new(RouterCore::new(Arc::new(router), TOKEN, classify, tokio::runtime::Handle::current()))
    }

    async fn ask(core: &Guarded, method: &str, target: &str, body: &str) -> (Head, String) {
        let (sink, out) = channel();
        let headers = vec![(TOKEN_HEADER.to_string(), TOKEN.to_string())];
        let req = Req {
            method: method.into(),
            url: target.into(),
            headers,
            body: body.as_bytes().to_vec(),
            ..Default::default()
        };
        core.call(Plane::Api, req, sink);
        let text = read_to_end(&out).await;
        (out.head().expect("head"), text)
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
    async fn reads_and_classified_writes_reach_the_router_with_their_timing() {
        let core = Guarded::new(rust());
        let (head, body) = ask(&core, "GET", "/api/pages?project=x", "").await;
        assert_eq!(body, r#"{"user":true}"#);
        assert!(head.headers.iter().any(|(name, value)| name == "server-timing" && value.starts_with("rust")));
        let (_, body) = ask(&core, "PUT", "/api/pages/p1", "{}").await;
        assert_eq!(body, r#"{"user":true}"#);
        let status = core.status();
        assert_eq!((status["rust"].as_u64(), status["refused"].as_u64()), (Some(2), Some(0)));
        assert_eq!(status["routes"], json!(["GET /api/pages", "PUT /api/pages/{id}"]));
    }

    #[tokio::test]
    async fn the_router_never_sees_a_request_that_could_make_an_agent_run() {
        let core = Guarded::new(rust());
        for target in ["/workers/w1/message", "/workers/w1/brand-new"] {
            let (head, body) = ask(&core, "POST", target, "{}").await;
            assert_eq!(head.status, 403, "{target}");
            assert!(body.contains("refused in a dev run"), "{body}");
        }
        let status = core.status();
        assert_eq!((status["rust"].as_u64(), status["refused"].as_u64()), (Some(0), Some(2)));
        // A run started to try agents lets them through.
        let allowed = Guarded::new(rust()).allow_agents(true);
        let (head, body) = ask(&allowed, "POST", "/workers/w1/message", "{}").await;
        assert_eq!((head.status, body.as_str()), (200, r#"{"user":true}"#));
    }

    #[tokio::test]
    async fn the_files_panel_writes_only_inside_the_data_folder() {
        let core = Guarded::new(rust()).data_folder("/data/run-copy");
        let (head, _) = ask(&core, "POST", "/fs/write", r#"{"path":"/data/run-copy/a.txt"}"#).await;
        assert_eq!(head.status, 200);
        let (head, _) = ask(&core, "POST", "/fs/write", r#"{"path":"/Users/someone/a.txt"}"#).await;
        assert_eq!(head.status, 403);
        // Without a data folder nothing may be written.
        let (head, _) = ask(&Guarded::new(rust()), "POST", "/fs/write", r#"{"path":"/data/run-copy/a.txt"}"#).await;
        assert_eq!(head.status, 403);
    }
}
