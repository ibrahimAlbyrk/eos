//! What the bridge needs from the core: its router, and the ui-token it checks.
//!
//! `eos-runtime`'s `Router` is the real implementation (`router::RouterCore`, a thin
//! mapping from [`Req`] and [`Sink`] to its request and response types). Until it declares
//! every route, the `dev-proxy` feature sends the routes it does not declare to an isolated
//! Node daemon (`dev::Hybrid`).

use crate::transport::{Req, Sink};

/// The core has two routers: the API, and raw content on its own origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plane {
    Api,
    Raw,
}

pub trait Core: Send + Sync + 'static {
    /// The token that proves a request comes from this Mac's dashboard.
    fn ui_token(&self) -> String;

    /// Routes one request. `req.url` is the origin-form target (`/path?query`). Must not
    /// block: answer through `sink` now or later, from any thread.
    fn call(&self, plane: Plane, req: Req, sink: Sink);

    /// Counters for diagnostics (no user data); shown in the shell's status.
    fn status(&self) -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// Stands in while no core is built in: every route answers 503.
#[derive(Debug, Clone, Default)]
pub struct NoCore {
    pub ui_token: String,
}

impl Core for NoCore {
    fn ui_token(&self) -> String {
        self.ui_token.clone()
    }

    fn call(&self, _plane: Plane, _req: Req, sink: Sink) {
        sink.respond(503, vec![("content-type".into(), "application/json".into())], br#"{"error":"core_unavailable"}"#);
    }
}
