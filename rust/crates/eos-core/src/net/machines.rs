//! This computer and the ones paired with it, as a feature that talks to
//! them needs it (`manager/peer/HostLinkService.ts`, `HostLink.ts`).

use bytes::Bytes;
use eos_contracts::HostView;

use crate::BoxFuture;

/// One request to a paired computer's own routes, sent over its link as the
/// user of this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRequest {
    pub method: &'static str,
    /// Path and query, as the other computer's router reads it.
    pub target: String,
    pub content_type: Option<&'static str>,
    pub body: Bytes,
    /// How long to wait for the link to come up before giving up.
    pub ready_ms: u64,
    /// How long the answer may take once the request is out.
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerResponse {
    pub status: u16,
    pub body: Bytes,
}

/// Why a request to a paired computer got no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PeerCallError {
    #[error("that computer isn't paired any more")]
    NotPaired,
    #[error("that computer isn't reachable right now")]
    NotReady,
    /// This run dials no other computer at all.
    #[error("only the installed Eos on your own data folder reaches other computers")]
    OffNetwork,
    #[error("the link to that computer dropped")]
    Dropped,
    #[error("the other computer stopped answering")]
    TimedOut,
}

pub trait Machines: Send + Sync + 'static {
    /// This computer's name, as the others show it.
    fn local_name(&self) -> String;
    /// The paired computers with the state of their links.
    fn list(&self) -> Vec<HostView>;
    fn get(&self, id: &str) -> Option<HostView>;
    fn call<'a>(&'a self, host_id: &'a str, request: PeerRequest)
    -> BoxFuture<'a, Result<PeerResponse, PeerCallError>>;
}
