//! What a recording runs against. Today that is a daemon behind HTTP
//! ([`crate::http::HttpTarget`]); the Rust core's in-process router implements
//! the same two calls later, so recordings carry over unchanged.

use std::sync::mpsc::Receiver;

use crate::model::Via;
use crate::sse::SseItem;

/// A request as the runner hands it over: variables filled, token attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub via: Via,
    pub method: String,
    /// Path with its query string.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

/// A complete answer. Header names are lowercase; the body is already decoded
/// from its transfer and content encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// An open event stream. Dropping it closes the stream.
pub struct Stream {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub items: Receiver<SseItem>,
    close: Option<Box<dyn FnOnce() + Send>>,
}

impl Stream {
    pub fn new(
        status: u16,
        headers: Vec<(String, String)>,
        items: Receiver<SseItem>,
        close: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self { status, headers, items, close: Some(Box::new(close)) }
    }
}

impl std::fmt::Debug for Stream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stream").field("status", &self.status).field("headers", &self.headers).finish_non_exhaustive()
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if let Some(close) = self.close.take() {
            close();
        }
    }
}

/// The seam between recordings and whatever answers them.
pub trait Target {
    fn send(&mut self, request: &Request) -> anyhow::Result<Response>;
    fn open_stream(&mut self, request: &Request) -> anyhow::Result<Stream>;
    /// A second handle on the same target, for a request that stays open while
    /// other steps run (a permission ask waits for the user's decision).
    fn fork(&self) -> Box<dyn Target + Send>;
}
