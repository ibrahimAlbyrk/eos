//! One computer controlling another.
//!
//! | Part | What it is |
//! |---|---|
//! | [`routes`] | Settings › Remote access (hosting on/off, invites, devices) and the Machines menu (hosts, connect, forget) |
//! | [`facade`] | `/h/<hostId>/…` on this computer **is** that host's app: each request rides its link |
//! | [`gateway`] | a paired computer's request, handed to this app's own router in process |
//! | [`ui`] | `GET /ui/*`: this app's dashboard bundle, for a computer that controls it |
//! | [`events`] | what the link announces, on the bus |
//!
//! ## What the window shell provides
//!
//! - **The go for the network.** `eos_app::Options::reaches_network = true`,
//!   only in the installed app on the user's own data folder. Without it the
//!   settings answer, saying why (`off: "off-network"`, and every host's
//!   link `error: "off-network"`), no invite is made, and nothing listens or
//!   dials.
//! - **The bundle.** `eos_app::Options::dashboard`: the folder of the
//!   dashboard bundle, so `GET /ui/*` serves it and `servesUi` is true.
//! - **A view per controlled host**, in its own profile, with a content
//!   policy pinned to that host's prefix (`/h/<id>/…` on the app's origin and
//!   on the raw-content origin) and none of the shell's bridges. It runs this
//!   app's dashboard when the host's `apiStamp` equals [`api_stamp`], else the
//!   host's own bundle from `/h/<id>/ui/`.
//! - **Who the view is.** Its requests reach the router as
//!   `Caller::Local(LocalCaller::HostView { host })`: either the shell tags
//!   them by the view they come from, or the view sends the token of
//!   `POST /api/hosts/<id>/view-token` as `x-eos-ui-token` with every request
//!   under its prefix (sub-resources and the event stream included) and the
//!   bridge classifies with `eos_app::Callers::classify_for(token, target)`.
//! - **Wake.** `eos_app::App::peering().kick()` when the computer wakes.
//! - **Notifications.** A `notification:fire` whose payload has
//!   `host: { id, name }` came from that host: a click switches to its view.
//! - **Local Network privacy.** The app itself dials LAN addresses now, so
//!   its bundle needs `NSLocalNetworkUsageDescription`.
//!
//! Hosting and controlling are the user's own settings: every route under
//! `/api/peer`, `/api/hosts` and `/h` needs the dashboard and never crosses to
//! a paired computer. `GET /api/host` is an open read — a controlling
//! dashboard learns who it is talking to through the facade.

pub mod events;
pub mod facade;
pub mod gateway;
pub mod routes;
pub mod stamp;
pub mod ui;

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::stream::topics;
use eos_core::net::peer::{HostLinks, PeerHosting, PeerLifecycle};
use eos_core::store::ConfigSource;
use eos_domain::peer::ViewTokens;
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use serde::Serialize;

use eos_runtime::http::Response;

pub use events::BusEvents;
pub use gateway::RouterApi;
pub use stamp::api_stamp;

/// `peer:presence`: the paired devices connected to this computer right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PeerPresence {
    pub devices: Vec<PresentDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentDevice {
    pub fp: String,
    pub name: String,
    pub device_id: String,
}

/// `hosts:change`: a controlled computer's record or link state changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostsChange {
    pub id: String,
}

pub const PEER_PRESENCE: Topic<PeerPresence> = Topic::new(topics::PEER_PRESENCE);
pub const HOSTS_CHANGE: Topic<HostsChange> = Topic::new(topics::HOSTS_CHANGE);

/// What the feature is built from.
#[derive(Clone)]
pub struct PeerParts {
    pub hosting: Arc<dyn PeerHosting>,
    pub links: Arc<dyn HostLinks>,
    pub lifecycle: Arc<dyn PeerLifecycle>,
    pub config: Arc<dyn ConfigSource>,
    pub view_tokens: Arc<ViewTokens>,
    /// The folder of this app's own dashboard bundle (`index.html` inside
    /// it), when the app ships one.
    pub ui_root: Option<PathBuf>,
}

impl std::fmt::Debug for PeerParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerParts").field("ui_root", &self.ui_root).finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct PeerModule {
    parts: PeerParts,
}

impl PeerModule {
    pub fn new(parts: PeerParts) -> Self {
        Self { parts }
    }

    /// The facade on the raw-content origin: a controlled computer's files
    /// for the viewers (`/h/<hostId>/fs/raw/…`), over the same link.
    pub fn raw_routes(&self) -> Vec<RouteDef> {
        facade::routes(self.parts.links.clone())
    }
}

impl Module for PeerModule {
    fn id(&self) -> &'static str {
        "peer"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut all = routes::all(&self.parts);
        all.extend(facade::routes(self.parts.links.clone()));
        all.extend(ui::routes(self.parts.ui_root.clone()));
        all
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![PEER_PRESENCE.decl(), HOSTS_CHANGE.decl()]
    }

    /// Only the one app on this data folder listens and keeps links: two
    /// would fight over the port and the relay room.
    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.parts.lifecycle.start().await;
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.parts.lifecycle.stop();
        Box::pin(std::future::ready(()))
    }
}

/// The router's own answer for a path no route matches: today's routes match
/// only a 64-hex id, so anything else has no route.
pub(crate) fn no_route(path: &str) -> Response {
    #[derive(Serialize)]
    struct NotFound<'a> {
        error: &'a str,
        path: &'a str,
    }
    Response::json(404, &NotFound { error: "not found", path })
}
