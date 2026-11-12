//! One computer controlling another (`manager/peer`): what the feature asks
//! of the peer link, and what the link asks of the app.
//!
//! Hosting is this computer letting paired ones drive it; controlling is this
//! computer driving the ones it paired with. Both go over the same link: an
//! HTTP/2 connection inside TLS with both certificates pinned.

use bytes::Bytes;
use eos_contracts::{HostInfo, HostView, InviteResponse, PeerStatus, UpdateHostRequest};

use crate::BoxFuture;

/// A body that arrives in pieces. Dropping it tells the sender to stop.
pub trait ByteStream: Send + 'static {
    /// The next piece; `None` at the end, `Err` when the body was cut off.
    fn next(&mut self) -> BoxFuture<'_, Option<Result<Bytes, String>>>;
}

/// An answer that crosses a link, in either direction. Header names are in
/// lower case.
pub struct PeerAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn ByteStream>,
}

impl std::fmt::Debug for PeerAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerAnswer")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .finish_non_exhaustive()
    }
}

/// A paired computer's request, as the link hands it to this app's routes.
#[derive(Debug, Clone)]
pub struct PeerCall {
    /// The certificate fingerprint of the computer that sent it.
    pub device: String,
    /// That computer vouched its own dashboard made the request.
    pub human: bool,
    pub method: String,
    /// Path and query, exactly as sent: the router resolves it.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

/// This app's own routes, as a paired computer reaches them. Implemented over
/// the router by the peering feature.
pub trait LocalApi: Send + Sync + 'static {
    /// How many body bytes the route `target` resolves to accepts: the link
    /// stops reading there instead of buffering what will be refused.
    fn body_limit(&self, method: &str, target: &str) -> usize;
    fn call(&self, call: PeerCall) -> BoxFuture<'_, PeerAnswer>;
}

/// A paired device connected to this computer right now (`peer:presence`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectedDevice {
    pub fp: String,
    pub name: String,
    pub device_id: String,
}

/// What the link tells the app while it runs. Calls come from the link's own
/// tasks and must not block.
pub trait PeerEvents: Send + Sync + 'static {
    /// The devices connected to this computer changed.
    fn presence(&self, devices: Vec<ConnectedDevice>);
    /// A controlled computer's record or link state changed.
    fn host_changed(&self, host_id: &str);
    /// A controlled computer raised a notification (`notification:fire`'s
    /// payload, already titled with that computer's name).
    fn notification(&self, payload: serde_json::Value);
}

/// The link's life. It runs only in the one app that owns the data folder:
/// two would fight over the port and the relay room.
pub trait PeerLifecycle: Send + Sync + 'static {
    /// Applies the configuration (listens when hosting is on) and brings the
    /// link of every paired computer up.
    fn start(&self) -> BoxFuture<'_, ()>;
    /// Closes the listener, every session and every link.
    fn stop(&self);
    /// The computer woke or moved to another network: probe every link now.
    fn kick(&self);
}

/// Hosting is switched off (`config.peer.enabled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("remote access is off")]
pub struct HostingOff;

/// This computer as a host: Settings › Remote access.
pub trait PeerHosting: Send + Sync + 'static {
    fn host_info(&self) -> HostInfo;
    fn status(&self) -> PeerStatus;
    /// Mints a single-use invite link.
    fn create_invite(&self) -> Result<InviteResponse, HostingOff>;
    /// Every open invite stops working; answers how many there were.
    fn cancel_invites(&self) -> usize;
    /// Forgets a paired device and drops its connections.
    fn revoke(&self, fp: &str) -> bool;
    /// Drops a device's connections; answers how many there were.
    fn disconnect(&self, fp: &str) -> usize;
    /// Applies `config.peer` as it is now: listen, stop listening, open or
    /// close the relay room.
    fn reconcile(&self) -> BoxFuture<'_, ()>;
}

/// Why pairing failed, with the status the route answers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PairingError {
    pub status: u16,
    pub message: String,
}

/// A request for a controlled computer's own routes.
#[derive(Debug, Clone)]
pub struct LinkRequest {
    pub method: String,
    /// Path and query on that computer.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    /// The caller here was this computer's dashboard (or that host's view).
    pub human: bool,
}

/// Why a request did not reach a controlled computer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LinkError {
    #[error("unknown computer")]
    UnknownHost,
    /// No live link within the wait; `code` is the link's error
    /// (`unreachable`, `not-paired`, `local-network`, …).
    #[error("that computer is not reachable right now")]
    Unavailable { code: String },
    /// The link failed before the answer began.
    #[error("link to that computer failed: {0}")]
    Failed(String),
}

/// The computers this one controls: the Machines menu.
pub trait HostLinks: Send + Sync + 'static {
    fn list(&self) -> Vec<HostView>;
    fn get(&self, id: &str) -> Option<HostView>;
    /// Redeems an invite. With `mutual`, that computer may control this one
    /// too once it accepts; the answer says whether it did.
    fn pair<'a>(
        &'a self,
        invite: &'a str,
        alias: Option<&'a str>,
        mutual: bool,
    ) -> BoxFuture<'a, Result<(HostView, bool), PairingError>>;
    fn update(&self, id: &str, patch: &UpdateHostRequest) -> Option<HostView>;
    fn forget(&self, id: &str) -> bool;
    /// Probes the link now; `false` for an unknown computer.
    fn reconnect(&self, id: &str) -> bool;
    /// Sends one request over the computer's link and answers as its headers
    /// arrive; the body streams. Waits a while for a link that is coming up.
    fn forward<'a>(&'a self, host_id: &'a str, request: LinkRequest) -> BoxFuture<'a, Result<PeerAnswer, LinkError>>;
}
